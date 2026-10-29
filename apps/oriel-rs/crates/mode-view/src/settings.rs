//! View's settings and remembered folders, in Electron Oriel's settings file
//! (`frame-view-settings.json`, written by `settingsService.ts` and read by
//! `settingsPersistence.ts`): the same keys, the same defaults, the same leniency on a file that
//! is partly wrong, and the same version-3 envelope, so a later plan can point Oriel RS at
//! Electron Oriel's file.
//!
//! The file lives in `DataRoot::view()`. The window's bounds, which Electron Oriel kept here
//! before Oriel's shell kept them, are read and written back as they were.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use oriel_core_domain::{GallerySortMode, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The settings file's name in View's folder.
pub const SETTINGS_FILE_NAME: &str = "frame-view-settings.json";

/// The envelope's version; older files are migrated when read.
const PERSISTED_STATE_VERSION: u64 = 3;

/// Extensions added to the defaults after lists could be saved; a file from before version 3
/// gets them once (`BACKFILLED_IMAGE_EXTENSIONS`, `BACKFILLED_VIDEO_EXTENSIONS`).
const BACKFILLED_IMAGE_EXTENSIONS: [&str; 2] = ["gif", "avif"];
const BACKFILLED_VIDEO_EXTENSIONS: [&str; 1] = ["m4v"];

const MAX_PATH_LENGTH: usize = 4096;
const MAX_EXTENSION_COUNT: usize = 64;
const MAX_EXTENSION_LENGTH: usize = 16;
const MAX_EXCLUDED_CHILDREN: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterSettings {
    pub image_extensions: Vec<String>,
    pub video_extensions: Vec<String>,
    pub show_images: bool,
    pub show_videos: bool,
}

/// What View keeps per opened folder: comic mode, and the children a recursive scan skips.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootGalleryPreferences {
    pub comic_mode: bool,
    pub excluded_root_child_paths: Vec<String>,
}

impl RootGalleryPreferences {
    /// `toggleExcludedRootChildPath`: excludes `folder` if it was included, and includes it if it
    /// was excluded, keeping the others in their order.
    pub fn toggle_excluded(&mut self, folder: &str) {
        if let Some(at) = self
            .excluded_root_child_paths
            .iter()
            .position(|path| path == folder)
        {
            self.excluded_root_child_paths.remove(at);
        } else {
            self.excluded_root_child_paths.push(folder.to_owned());
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugSettings {
    pub enable_debug_logging: bool,
    pub enable_performance_monitoring: bool,
}

/// View's settings: `AppSettingsSchema`, its keys in its order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSettings {
    pub theme: ThemeMode,
    pub remember_last_folder: bool,
    pub recursive_default: bool,
    pub autoplay_on_hover: bool,
    pub autoplay_videos: bool,
    pub loop_viewer_navigation: bool,
    pub preview_audio_enabled: bool,
    pub loop_videos: bool,
    pub thumbnail_size: u32,
    pub sort_mode: GallerySortMode,
    pub random_seed: i64,
    pub filters: FileFilterSettings,
    pub root_gallery_preferences: BTreeMap<String, RootGalleryPreferences>,
    pub last_folder_path: Option<String>,
    /// The folder the owner opened, which the last folder is inside: View starts there again,
    /// able to step back up to it.
    pub last_opened_folder_path: Option<String>,
    pub debug: DebugSettings,
}

impl Default for ViewSettings {
    /// `DEFAULT_SETTINGS`.
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            remember_last_folder: true,
            recursive_default: false,
            autoplay_on_hover: true,
            autoplay_videos: true,
            loop_viewer_navigation: true,
            preview_audio_enabled: false,
            loop_videos: true,
            thumbnail_size: 220,
            sort_mode: GallerySortMode::NameAsc,
            random_seed: 1,
            filters: FileFilterSettings {
                image_extensions: IMAGE_EXTENSIONS.map(String::from).to_vec(),
                video_extensions: VIDEO_EXTENSIONS.map(String::from).to_vec(),
                show_images: true,
                show_videos: true,
            },
            root_gallery_preferences: BTreeMap::new(),
            last_folder_path: None,
            last_opened_folder_path: None,
            debug: DebugSettings::default(),
        }
    }
}

impl ViewSettings {
    /// `getRootGalleryPreferences`: the folder's preferences, or the defaults.
    pub fn root_preferences(&self, root: Option<&str>) -> RootGalleryPreferences {
        root.and_then(|root| self.root_gallery_preferences.get(root))
            .cloned()
            .unwrap_or_default()
    }

    /// `createRootGalleryPreferencesPatch`: stores `preferences` for `root`, its exclusions
    /// without repeats.
    pub fn set_root_preferences(&mut self, root: &str, mut preferences: RootGalleryPreferences) {
        let mut seen = std::collections::HashSet::new();
        preferences
            .excluded_root_child_paths
            .retain(|path| seen.insert(path.clone()));
        self.root_gallery_preferences
            .insert(root.to_owned(), preferences);
    }

    /// `normalizeAppSettings`: each field read on its own, and a field that is missing or wrong
    /// takes its default, so a file damaged in one place keeps the rest.
    pub fn from_json(value: &Value) -> Self {
        let defaults = Self::default();
        let raw = value.as_object();
        let field = |key: &str| raw.and_then(|raw| raw.get(key));
        let flag =
            |key: &str, default: bool| field(key).and_then(Value::as_bool).unwrap_or(default);
        let filters = field("filters").and_then(Value::as_object);
        let filter_flag = |key: &str, default: bool| {
            filters
                .and_then(|filters| filters.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(default)
        };
        let debug = field("debug").and_then(Value::as_object);
        let debug_flag = |key: &str| {
            debug
                .and_then(|debug| debug.get(key))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        };

        Self {
            theme: field("theme")
                .and_then(|theme| serde_json::from_value(theme.clone()).ok())
                .unwrap_or(defaults.theme),
            remember_last_folder: flag("rememberLastFolder", defaults.remember_last_folder),
            recursive_default: flag("recursiveDefault", defaults.recursive_default),
            autoplay_on_hover: flag("autoplayOnHover", defaults.autoplay_on_hover),
            autoplay_videos: flag("autoplayVideos", defaults.autoplay_videos),
            loop_viewer_navigation: flag("loopViewerNavigation", defaults.loop_viewer_navigation),
            preview_audio_enabled: flag("previewAudioEnabled", defaults.preview_audio_enabled),
            loop_videos: flag("loopVideos", defaults.loop_videos),
            thumbnail_size: field("thumbnailSize")
                .and_then(Value::as_f64)
                .filter(|size| size.is_finite())
                .map_or(defaults.thumbnail_size, thumbnail_size),
            sort_mode: field("sortMode")
                .and_then(|mode| serde_json::from_value(mode.clone()).ok())
                .unwrap_or(defaults.sort_mode),
            random_seed: field("randomSeed")
                .and_then(integer)
                .unwrap_or(defaults.random_seed),
            filters: FileFilterSettings {
                image_extensions: extensions(
                    filters.and_then(|filters| filters.get("imageExtensions")),
                    &defaults.filters.image_extensions,
                ),
                video_extensions: extensions(
                    filters.and_then(|filters| filters.get("videoExtensions")),
                    &defaults.filters.video_extensions,
                ),
                show_images: filter_flag("showImages", defaults.filters.show_images),
                show_videos: filter_flag("showVideos", defaults.filters.show_videos),
            },
            root_gallery_preferences: field("rootGalleryPreferences")
                .and_then(root_preferences)
                .unwrap_or_default(),
            last_folder_path: field("lastFolderPath").and_then(folder_path),
            last_opened_folder_path: field("lastOpenedFolderPath").and_then(folder_path),
            debug: DebugSettings {
                enable_debug_logging: debug_flag("enableDebugLogging"),
                enable_performance_monitoring: debug_flag("enablePerformanceMonitoring"),
            },
        }
    }

    /// Adds the extensions a file from before version 3 could not have had.
    fn backfill_extensions(&mut self) {
        for extension in BACKFILLED_IMAGE_EXTENSIONS {
            if !self
                .filters
                .image_extensions
                .iter()
                .any(|known| known == extension)
            {
                self.filters.image_extensions.push(extension.to_owned());
            }
        }
        for extension in BACKFILLED_VIDEO_EXTENSIONS {
            if !self
                .filters
                .video_extensions
                .iter()
                .any(|known| known == extension)
            {
                self.filters.video_extensions.push(extension.to_owned());
            }
        }
    }
}

/// `ThumbnailSizeSchema`: rounded, within 64 to 1024.
pub fn thumbnail_size(value: f64) -> u32 {
    value.round().clamp(64., 1024.) as u32
}

/// A JSON number that is a whole number, as zod's `int()` accepts one.
fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0. && number.abs() <= 9_007_199_254_740_991.)
            .map(|number| number as i64)
    })
}

/// `MediaExtensionsSchema`, falling back as `normalizeExtensions` does: each extension without
/// its leading dot, trimmed and lowercased, letters and digits only, at most 16 long; at most 64
/// of them, without repeats. Any bad one, or none, gives the defaults.
fn extensions(value: Option<&Value>, defaults: &[String]) -> Vec<String> {
    let parsed = value.and_then(Value::as_array).and_then(|list| {
        if list.len() > MAX_EXTENSION_COUNT {
            return None;
        }
        let mut extensions: Vec<String> = Vec::with_capacity(list.len());
        for item in list {
            let raw = item.as_str()?;
            let extension = raw.strip_prefix('.').unwrap_or(raw).trim().to_lowercase();
            let valid = !extension.is_empty()
                && extension.len() <= MAX_EXTENSION_LENGTH
                && extension
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
            if !valid {
                return None;
            }
            if !extensions.contains(&extension) {
                extensions.push(extension);
            }
        }
        Some(extensions)
    });
    match parsed {
        Some(extensions) if !extensions.is_empty() => extensions,
        _ => defaults.to_vec(),
    }
}

/// `PathInputSchema`: a string of 1 to 4096 characters, kept exactly.
fn path_input(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|path| !path.is_empty() && path.encode_utf16().count() <= MAX_PATH_LENGTH)
        .map(str::to_owned)
}

fn folder_path(value: &Value) -> Option<String> {
    path_input(value)
}

/// `RootGalleryPreferencesMapSchema`: every entry valid, or none kept.
fn root_preferences(value: &Value) -> Option<BTreeMap<String, RootGalleryPreferences>> {
    let map = value.as_object()?;
    let mut preferences = BTreeMap::new();
    for (root, entry) in map {
        path_input(&Value::String(root.clone()))?;
        let entry = entry.as_object()?;
        let comic_mode = entry.get("comicMode")?.as_bool()?;
        let excluded = entry.get("excludedRootChildPaths")?.as_array()?;
        if excluded.len() > MAX_EXCLUDED_CHILDREN {
            return None;
        }
        let excluded_root_child_paths = excluded
            .iter()
            .map(path_input)
            .collect::<Option<Vec<_>>>()?;
        preferences.insert(
            root.clone(),
            RootGalleryPreferences {
                comic_mode,
                excluded_root_child_paths,
            },
        );
    }
    Some(preferences)
}

/// The file: `PersistedState`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    version: u64,
    settings: ViewSettings,
    window_bounds: Value,
    window_maximized: bool,
}

impl PersistedState {
    /// `migratePersistedState`.
    fn from_json(value: &Value) -> Self {
        let mut settings = ViewSettings::from_json(value.get("settings").unwrap_or(&Value::Null));
        if value.get("version").and_then(Value::as_u64) != Some(PERSISTED_STATE_VERSION) {
            settings.backfill_extensions();
        }
        Self {
            version: PERSISTED_STATE_VERSION,
            settings,
            window_bounds: window_bounds(value.get("windowBounds")),
            window_maximized: value.get("windowMaximized") == Some(&Value::Bool(true))
                || value.get("windowFullscreen") == Some(&Value::Bool(true)),
        }
    }

    fn fresh(settings: ViewSettings) -> Self {
        Self {
            version: PERSISTED_STATE_VERSION,
            settings,
            window_bounds: Value::Null,
            window_maximized: false,
        }
    }
}

/// `normalizeWindowBounds`: whole numbers, at least 980 × 640, or null.
fn window_bounds(value: Option<&Value>) -> Value {
    let Some(bounds) = value.and_then(Value::as_object) else {
        return Value::Null;
    };
    let number = |key: &str| bounds.get(key).and_then(Value::as_f64);
    match (number("x"), number("y"), number("width"), number("height")) {
        (Some(x), Some(y), Some(width), Some(height)) => serde_json::json!({
            "x": x.round() as i64,
            "y": y.round() as i64,
            "width": (width.round() as i64).max(980),
            "height": (height.round() as i64).max(640),
        }),
        _ => Value::Null,
    }
}

/// View's settings and the file they live in. Changes are written at once, off the main thread,
/// newest last: the file is small, and a write must not be lost to a quit.
pub struct SettingsStore {
    path: Arc<Path>,
    state: PersistedState,
    writer: Arc<Mutex<u64>>,
    written: u64,
}

impl SettingsStore {
    /// Reads `frame-view-settings.json` in `folder`. A missing or unreadable file gives the
    /// defaults, which are written back, as `SettingsService.init` does.
    pub fn load(folder: &Path) -> Self {
        let path: Arc<Path> = folder.join(SETTINGS_FILE_NAME).into();
        let read = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        let fresh = read.is_none();
        let state = match read {
            Some(value) => PersistedState::from_json(&value),
            None => PersistedState::fresh(ViewSettings::default()),
        };
        let store = Self {
            path,
            state,
            writer: Arc::new(Mutex::new(0)),
            written: 0,
        };
        if fresh && let Err(error) = write_state(&store.path, &store.state) {
            log::warn!("cannot write View's settings: {error}");
        }
        store
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn settings(&self) -> &ViewSettings {
        &self.state.settings
    }

    /// Changes the settings and returns the write to run, which the caller hands to the
    /// background executor. Writes run in order; a write older than one already done is skipped.
    pub fn update(
        &mut self,
        change: impl FnOnce(&mut ViewSettings),
    ) -> impl FnOnce() + Send + 'static {
        change(&mut self.state.settings);
        self.written += 1;
        let sequence = self.written;
        let state = self.state.clone();
        let path = self.path.clone();
        let writer = self.writer.clone();
        move || {
            let mut last = writer.lock().unwrap_or_else(PoisonError::into_inner);
            if *last >= sequence {
                return;
            }
            match write_state(&path, &state) {
                Ok(()) => *last = sequence,
                Err(error) => log::warn!("cannot write View's settings: {error}"),
            }
        }
    }

    /// Changes the settings and writes them on this thread, for tests and the last write.
    pub fn update_now(&mut self, change: impl FnOnce(&mut ViewSettings)) {
        (self.update(change))();
    }
}

/// `writePersistedState`: two-space JSON, written beside the file and renamed over it.
fn write_state(path: &Path, state: &PersistedState) -> io::Result<()> {
    let text = serde_json::to_string_pretty(state).map_err(io::Error::other)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut temporary = PathBuf::from(path);
    temporary.as_mut_os_string().push(".tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Electron Oriel writes on its first start: `JSON.stringify` of the default state,
    /// indented by two.
    const ELECTRON_DEFAULT_FILE: &str = r#"{
  "version": 3,
  "settings": {
    "theme": "system",
    "rememberLastFolder": true,
    "recursiveDefault": false,
    "autoplayOnHover": true,
    "autoplayVideos": true,
    "loopViewerNavigation": true,
    "previewAudioEnabled": false,
    "loopVideos": true,
    "thumbnailSize": 220,
    "sortMode": "name-asc",
    "randomSeed": 1,
    "filters": {
      "imageExtensions": [
        "jpg",
        "jpeg",
        "png",
        "webp",
        "gif",
        "bmp",
        "avif"
      ],
      "videoExtensions": [
        "mp4",
        "webm",
        "mov",
        "mkv",
        "m4v"
      ],
      "showImages": true,
      "showVideos": true
    },
    "rootGalleryPreferences": {},
    "lastFolderPath": null,
    "lastOpenedFolderPath": null,
    "debug": {
      "enableDebugLogging": false,
      "enablePerformanceMonitoring": false
    }
  },
  "windowBounds": null,
  "windowMaximized": false
}"#;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-mode-view-settings")
            .join(format!("{test}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn a_first_start_writes_the_file_electron_oriel_writes() {
        let folder = scratch("first-start");
        let store = SettingsStore::load(&folder);
        assert_eq!(store.settings(), &ViewSettings::default());
        assert_eq!(
            fs::read_to_string(folder.join(SETTINGS_FILE_NAME)).unwrap(),
            ELECTRON_DEFAULT_FILE
        );
    }

    #[test]
    fn reads_electron_oriels_file_and_writes_it_back_the_same() {
        let folder = scratch("round-trip");
        let file = ELECTRON_DEFAULT_FILE
            .replace(r#""sortMode": "name-asc""#, r#""sortMode": "random""#)
            .replace(r#""randomSeed": 1"#, r#""randomSeed": 3735928559"#)
            .replace(
                r#""rootGalleryPreferences": {}"#,
                r#""rootGalleryPreferences": {
      "/Volumes/Archive": {
        "comicMode": true,
        "excludedRootChildPaths": [
          "/Volumes/Archive/bulk"
        ]
      }
    }"#,
            )
            .replace(
                r#""lastFolderPath": null"#,
                r#""lastFolderPath": "/Volumes/Archive/2024""#,
            )
            .replace(
                r#""windowBounds": null"#,
                r#""windowBounds": {
    "x": 10,
    "y": 20,
    "width": 1320,
    "height": 860
  }"#,
            );
        fs::write(folder.join(SETTINGS_FILE_NAME), &file).unwrap();
        let mut store = SettingsStore::load(&folder);
        let settings = store.settings().clone();
        assert_eq!(settings.sort_mode, GallerySortMode::Random);
        assert_eq!(settings.random_seed, 3_735_928_559);
        assert_eq!(
            settings.last_folder_path.as_deref(),
            Some("/Volumes/Archive/2024")
        );
        assert!(
            settings
                .root_preferences(Some("/Volumes/Archive"))
                .comic_mode
        );
        store.update_now(|_| {});
        assert_eq!(
            fs::read_to_string(folder.join(SETTINGS_FILE_NAME)).unwrap(),
            file
        );
    }

    #[test]
    fn a_damaged_field_falls_back_alone() {
        let value = serde_json::json!({
            "theme": "sepia",
            "rememberLastFolder": false,
            "thumbnailSize": 9000.4,
            "sortMode": "date-newest",
            "randomSeed": 1.5,
            "filters": {
                "imageExtensions": [".JPG", " png ", "jpg"],
                "videoExtensions": ["mp4", "not valid"],
                "showVideos": false
            },
            "rootGalleryPreferences": { "/a": { "comicMode": "yes" } },
            "lastFolderPath": "",
            "debug": { "enableDebugLogging": true }
        });
        let settings = ViewSettings::from_json(&value);
        let defaults = ViewSettings::default();
        assert_eq!(settings.theme, ThemeMode::System);
        assert!(!settings.remember_last_folder);
        assert_eq!(settings.thumbnail_size, 1024);
        assert_eq!(settings.sort_mode, GallerySortMode::DateNewest);
        assert_eq!(settings.random_seed, 1);
        assert_eq!(settings.filters.image_extensions, ["jpg", "png"]);
        assert_eq!(
            settings.filters.video_extensions,
            defaults.filters.video_extensions
        );
        assert!(settings.filters.show_images && !settings.filters.show_videos);
        assert!(settings.root_gallery_preferences.is_empty());
        assert_eq!(settings.last_folder_path, None);
        assert!(settings.debug.enable_debug_logging);
        assert!(!settings.debug.enable_performance_monitoring);
    }

    #[test]
    fn an_old_file_gets_the_newer_extensions_once() {
        let value = serde_json::json!({
            "version": 2,
            "settings": { "filters": { "imageExtensions": ["jpg"], "videoExtensions": ["mp4"] } },
            "windowFullscreen": true
        });
        let state = PersistedState::from_json(&value);
        assert_eq!(
            state.settings.filters.image_extensions,
            ["jpg", "gif", "avif"]
        );
        assert_eq!(state.settings.filters.video_extensions, ["mp4", "m4v"]);
        assert!(state.window_maximized);
        let current = serde_json::json!({
            "version": 3,
            "settings": { "filters": { "imageExtensions": ["jpg"], "videoExtensions": ["mp4"] } }
        });
        assert_eq!(
            PersistedState::from_json(&current)
                .settings
                .filters
                .image_extensions,
            ["jpg"]
        );
    }

    #[test]
    fn excluded_children_toggle() {
        let mut preferences = RootGalleryPreferences::default();
        preferences.toggle_excluded("/r/a");
        preferences.toggle_excluded("/r/b");
        preferences.toggle_excluded("/r/a");
        assert_eq!(preferences.excluded_root_child_paths, ["/r/b"]);
    }
}
