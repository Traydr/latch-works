//! The window's small store of preferences, what `localStorage` holds for Electron Oriel's window:
//! the theme, the sidebar's form, the mode shown last, and each mode's own view preferences, under
//! the same keys and with the same values (`oriel.theme` = `dark`, `oriel.sidebar` = `rail`,
//! `oriel.mode` = `tidy`, `oriel.tidy.view` = `library`, …).
//!
//! Electron Oriel kept these in Chromium's Local Storage, a LevelDB nothing else reads, so Oriel
//! keeps the same entries in one JSON object of strings instead, `local-storage.json` in
//! `DataRoot::shell()`.
//!
//! A mode remembers its own page here, as Electron Oriel's modes do: Tidy under
//! `oriel.tidy.view`, for one.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use gpui_kit::{App, Global};

/// The file in the shell's data folder.
pub const FILE_NAME: &str = "local-storage.json";

/// The entries, and the file they are kept in. One per app, as a GPUI global.
#[derive(Debug, Default)]
pub struct LocalStorage {
    file: Option<PathBuf>,
    entries: BTreeMap<String, String>,
}

impl Global for LocalStorage {}

impl LocalStorage {
    /// The store kept in `folder`, with what it held last time. A missing file starts empty, and
    /// so does one that does not parse, which the next write replaces.
    pub fn open(folder: &Path) -> Self {
        let file = folder.join(FILE_NAME);
        let entries = match std::fs::read_to_string(&file) {
            Ok(text) => parse(&text).unwrap_or_else(|| {
                log::warn!("{} is not a JSON object; starting empty", file.display());
                BTreeMap::new()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                log::warn!("could not read {}: {error}", file.display());
                BTreeMap::new()
            }
        };
        Self {
            file: Some(file),
            entries,
        }
    }

    /// Makes `storage` the app's store. Until this runs, reads find nothing and writes are kept in
    /// memory only, which is what a mode's own tests want.
    pub fn init(storage: Self, cx: &mut App) {
        cx.set_global(storage);
    }

    /// The value under `key`, if one was stored.
    pub fn get<'a>(cx: &'a App, key: &str) -> Option<&'a str> {
        cx.try_global::<Self>()?
            .entries
            .get(key)
            .map(String::as_str)
    }

    /// Stores `value` under `key` and writes the file, unless it holds that value already.
    pub fn set(cx: &mut App, key: &str, value: &str) {
        let storage = cx.default_global::<Self>();
        if storage
            .entries
            .get(key)
            .is_some_and(|stored| stored == value)
        {
            return;
        }
        storage.entries.insert(key.to_string(), value.to_string());
        storage.save();
    }

    /// Forgets `key` and writes the file.
    pub fn remove(cx: &mut App, key: &str) {
        let storage = cx.default_global::<Self>();
        if storage.entries.remove(key).is_some() {
            storage.save();
        }
    }

    /// The file this store is kept in, if any.
    pub fn file(&self) -> Option<&Path> {
        self.file.as_deref()
    }

    /// Writes every entry, through a temporary file so a crash mid-write cannot leave half a file.
    /// A failure is logged: the preferences then last only as long as this run.
    fn save(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let text = serde_json::to_string(&self.entries).expect("a map of strings serializes");
        if let Err(error) = write_atomically(file, text.as_bytes()) {
            log::warn!("could not write {}: {error}", file.display());
        }
    }
}

/// The string entries of a JSON object; anything else in it is dropped.
fn parse(text: &str) -> Option<BTreeMap<String, String>> {
    let serde_json::Value::Object(object) = serde_json::from_str(text).ok()? else {
        return None;
    };
    Some(
        object
            .into_iter()
            .filter_map(|(key, value)| match value {
                serde_json::Value::String(value) => Some((key, value)),
                _ => None,
            })
            .collect(),
    )
}

/// Writes `bytes` to `file` by way of a sibling temporary file and a rename.
pub fn write_atomically(file: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(test: &str) -> PathBuf {
        let folder = std::env::temp_dir()
            .join("oriel-ui-storage-tests")
            .join(format!("{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder
    }

    #[test]
    fn keeps_string_entries_and_drops_the_rest() {
        let parsed = parse(r#"{"oriel.theme":"dark","oriel.count":3,"oriel.mode":"sync"}"#)
            .expect("an object");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed["oriel.theme"], "dark");
        assert!(parse("[1, 2]").is_none());
        assert!(parse("not json").is_none());
    }

    #[test]
    fn writes_what_it_reads_back() {
        let folder = scratch("round-trip");
        let mut storage = LocalStorage::open(&folder);
        assert!(storage.entries.is_empty(), "a missing file starts empty");
        storage
            .entries
            .insert("oriel.sidebar".into(), "rail".into());
        storage.save();

        let text = std::fs::read_to_string(folder.join(FILE_NAME)).unwrap();
        assert_eq!(text, r#"{"oriel.sidebar":"rail"}"#);
        let reopened = LocalStorage::open(&folder);
        assert_eq!(reopened.entries["oriel.sidebar"], "rail");
    }
}
