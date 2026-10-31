//! What Electron Oriel's data holds, counted before anything is copied, for the welcome and the
//! confirmation to show.

use std::fs;
use std::path::{Path, PathBuf};

use oriel_core_paths::DataRoot;
use serde_json::Value;

use crate::files::{Progress, Size, is_empty, remove_own, tree_size, with_suffix};
use crate::report::{Area, bytes, count};
use crate::source::ElectronData;
use crate::{leveldb, sqlite};

/// The files each area reads, by name, as Electron Oriel writes them.
pub(crate) const WINDOW_STATE: &str = "window-state.json";
pub(crate) const WELCOMED: &str = "welcomed";
pub(crate) const VIEW_SETTINGS: &str = "frame-view-settings.json";
pub(crate) const MEDIA_INDEX: &str = "media-index.sqlite";
pub(crate) const CATALOG: &str = "catalog.sqlite";
pub(crate) const SYNC_SETTINGS: &str = "lockstep-settings.json";
pub(crate) const SECRET_KEY: &str = "secret-storage.key";

/// `<userData>/Local Storage/leveldb`.
pub(crate) fn local_storage_folder(oriel: &Path) -> PathBuf {
    oriel.join("Local Storage").join("leveldb")
}

/// View's thumbnails, `frame-view/thumbnails` in its folder, in Electron Oriel and Oriel RS alike.
pub(crate) fn thumbnail_folder(view: &Path) -> PathBuf {
    view.join("frame-view").join("thumbnails")
}

/// What was found, area by area.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Survey {
    pub window_state: bool,
    /// The window's `localStorage` entries.
    pub preferences: u64,
    pub view_settings: bool,
    /// View remembers a folder.
    pub view_folder: bool,
    pub media_index: Size,
    pub thumbnails: Size,
    pub catalog: bool,
    pub tidy_folders: u64,
    /// The files Tidy holds, as its catalog counts them.
    pub held: Size,
    /// Why Tidy's catalog could not be read, when it could not.
    pub tidy_problem: Option<String>,
    pub sync_profiles: u64,
    /// The profiles' saved tokens.
    pub sync_tokens: u64,
    pub hash_cache: Size,
    /// The apps that must quit first.
    pub running: Vec<&'static str>,
}

impl Survey {
    /// Counts what `source` holds. Tidy's catalog is read from a copy in a scratch folder under
    /// `data`, removed afterwards.
    pub fn of(source: &ElectronData, data: &DataRoot) -> Self {
        let mut survey = Self {
            running: source.running(),
            window_state: source.oriel().join(WINDOW_STATE).is_file(),
            preferences: leveldb::local_storage(
                &local_storage_folder(source.oriel()),
                leveldb::FILE_ORIGIN,
            )
            .map_or(0, |entries| entries.len() as u64),
            ..Self::default()
        };

        let view = source.frame_view();
        if let Some(settings) = read_json(&view.join(VIEW_SETTINGS)) {
            survey.view_settings = true;
            survey.view_folder = settings
                .pointer("/settings/lastFolderPath")
                .and_then(Value::as_str)
                .is_some_and(|folder| !folder.is_empty());
        }
        let index = view.join(MEDIA_INDEX);
        if index.is_file() {
            for suffix in ["", "-wal"] {
                survey
                    .media_index
                    .add(file_size(&with_suffix(&index, suffix)));
            }
        }
        survey.thumbnails = tree_size(&thumbnail_folder(view));

        let catalog = source.glazier().join(CATALOG);
        if catalog.is_file() {
            survey.catalog = true;
            match read_catalog(&catalog, data) {
                Ok((folders, held)) => {
                    survey.tidy_folders = folders;
                    survey.held = held;
                }
                Err(error) => survey.tidy_problem = Some(format!("{error:#}")),
            }
        }

        if let Some(settings) = read_json(&source.lockstep().join(SYNC_SETTINGS)) {
            let profiles = settings.get("profiles").and_then(Value::as_array);
            survey.sync_profiles = profiles.map_or(0, |profiles| profiles.len() as u64);
            survey.sync_tokens = profiles.map_or(0, |profiles| {
                profiles
                    .iter()
                    .filter(|profile| profile.get("encryptedToken").is_some())
                    .count() as u64
            });
        } else if crate::import::legacy_profile(source).is_some() {
            survey.sync_profiles = 1;
        }
        survey.hash_cache = tree_size(source.hash_cache());
        survey
    }

    /// Whether there is anything to import.
    pub fn found(&self) -> bool {
        self.areas().len() > 1 || self.window_state || self.preferences > 0
    }

    /// The areas an import writes. The shell's is always one, for the report and the welcome.
    pub fn areas(&self) -> Vec<Area> {
        let mut areas = vec![Area::Shell];
        if self.view_settings || self.media_index.files > 0 || self.thumbnails.files > 0 {
            areas.push(Area::View);
        }
        if self.catalog {
            areas.push(Area::Tidy);
        }
        if self.sync_profiles > 0 {
            areas.push(Area::Sync);
        }
        if self.hash_cache.files > 0 {
            areas.push(Area::HashCache);
        }
        areas
    }

    /// The areas whose folder in `data` already holds something, which the import moves aside.
    pub fn moves_aside(&self, data: &DataRoot) -> Vec<Area> {
        self.areas()
            .into_iter()
            .filter(|area| !is_empty(&data.root().join(area.folder())))
            .collect()
    }

    /// What was found, one row per mode, for the window: its name and a short line.
    pub fn rows(&self) -> Vec<(&'static str, String)> {
        let mut rows = Vec::new();
        let shell: Vec<String> = [
            self.window_state.then(|| "Its size and place".to_owned()),
            (self.preferences > 0).then(|| count(self.preferences, "preference", "preferences")),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !shell.is_empty() {
            rows.push(("Window", shell.join(" · ")));
        }
        if self.view_settings || self.thumbnails.files > 0 {
            rows.push((
                "View",
                if self.view_folder {
                    "Its folder and settings".to_owned()
                } else {
                    "Its settings; no folder".to_owned()
                },
            ));
        }
        if self.catalog {
            let line = match &self.tidy_problem {
                Some(_) => "A catalog that does not read".to_owned(),
                None => format!(
                    "{} · {}, {}",
                    count(self.tidy_folders, "folder", "folders"),
                    count(self.held.files, "held file", "held files"),
                    bytes(self.held.bytes)
                ),
            };
            rows.push(("Tidy", line));
        }
        if self.sync_profiles > 0 {
            let mut line = count(self.sync_profiles, "profile", "profiles");
            if self.sync_tokens > 0 {
                line = format!(
                    "{line} · {}",
                    count(self.sync_tokens, "saved token", "saved tokens")
                );
            }
            rows.push(("Sync", line));
        }
        let mut caches = Vec::new();
        if self.thumbnails.files > 0 {
            caches.push(format!("thumbnails {}", bytes(self.thumbnails.bytes)));
        }
        if self.media_index.files > 0 {
            caches.push(format!("media index {}", bytes(self.media_index.bytes)));
        }
        if self.hash_cache.files > 0 {
            caches.push(format!("hashes {}", bytes(self.hash_cache.bytes)));
        }
        if !caches.is_empty() {
            let mut line = caches.join(" · ");
            if let Some(first) = line.get_mut(..1) {
                first.make_ascii_uppercase();
            }
            rows.push(("Caches", line));
        }
        rows
    }
}

/// Tidy's folders and held files, from a copy of the catalog.
fn read_catalog(catalog: &Path, data: &DataRoot) -> anyhow::Result<(u64, Size)> {
    let scratch = Scratch::new(data)?;
    let connection = sqlite::open_copy(catalog, &scratch.0.join(CATALOG), &Progress::default())?;
    let folders: i64 = connection.query_row("SELECT count(*) FROM roots", [], |row| row.get(0))?;
    let (files, bytes): (i64, i64) = connection.query_row(
        "SELECT count(*), coalesce(sum(size), 0) FROM holding WHERE state = 'held'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    drop(connection);
    Ok((
        folders as u64,
        Size {
            files: files as u64,
            bytes: bytes as u64,
        },
    ))
}

/// A folder of the import's own under the data root, removed when dropped.
pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new(data: &DataRoot) -> std::io::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let folder = data
            .root()
            .join(format!("import-scratch-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&folder)?;
        Ok(Self(folder))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        remove_own(&self.0);
    }
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn file_size(path: &Path) -> Size {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Size {
            files: 1,
            bytes: metadata.len(),
        },
        _ => Size::default(),
    }
}
