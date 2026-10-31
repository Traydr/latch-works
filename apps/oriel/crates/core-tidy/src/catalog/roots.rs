//! Roots and settings, from glazier-core's `catalog/roots.ts`.

use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use oriel_core_paths::DataRoot;
use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

use super::now_ms;
use crate::contract::{PreferredFolder, Root, RootId, Settings, SimilarityLevel, VideoQuality};
use crate::plans::planner::is_within;

/// Every root, in path order without regard to case, with its file count and bytes.
pub fn list_roots(connection: &Connection) -> anyhow::Result<Vec<Root>> {
    let mut statement = connection.prepare_cached(
        "SELECT r.id, r.path, r.added_at, r.last_scan_at,
        (SELECT COUNT(*) FROM files f WHERE f.root_id = r.id) AS file_count,
        (SELECT SUM(size) FROM files f WHERE f.root_id = r.id) AS total_bytes
        FROM roots r ORDER BY r.path COLLATE NOCASE",
    )?;
    let rows = statement.query_map([], |row| {
        let path: String = row.get(1)?;
        Ok(Root {
            id: row.get(0)?,
            name: base_name(&path),
            path,
            added_at: row.get(2)?,
            last_scan_at: row.get(3)?,
            file_count: row.get(4)?,
            total_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The root with this id, if it is still configured.
pub fn find_root(connection: &Connection, root_id: RootId) -> anyhow::Result<Option<Root>> {
    Ok(list_roots(connection)?
        .into_iter()
        .find(|root| root.id == root_id))
}

/// `path.basename(path) || path`.
fn base_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_owned())
}

/// Why a folder cannot become a root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootError(pub String);

impl std::fmt::Display for RootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RootError {}

/// Resolves a folder the way glazier-core's `addRoot` does (absolute, symlinks resolved), refusing
/// a missing folder or a file as it does. In a sandboxed run (`ORIEL_DATA_DIR` set) it also
/// refuses a folder outside [`DataRoot::sandbox`] and the temp folder; the resolved path is what
/// is checked, so a symlink in the sandbox pointing elsewhere is refused too.
pub fn resolve_root_folder(data: &DataRoot, folder: &Path) -> Result<PathBuf, RootError> {
    let absolute = if folder.is_absolute() {
        folder.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| RootError(format!("No working folder: {error}")))?
            .join(folder)
    };
    // Node's `realpath`: on Windows without the `\\?\` prefix std's `canonicalize` adds, so the
    // root is stored, shown and compared as Electron Oriel's are. std's file calls add the long
    // form back themselves for a path that needs it.
    let resolved = oriel_runtime::paths::canonicalize(&absolute)
        .map_err(|_| RootError(format!("{} does not exist.", folder.display())))?;
    if !resolved.is_dir() {
        return Err(RootError(format!(
            "{} is not a folder.",
            resolved.display()
        )));
    }
    if !data.admits_tidy_root(&resolved) {
        return Err(RootError(format!(
            "{} is outside Tidy's sandbox. With ORIEL_DATA_DIR set, Tidy looks after \
             folders only under {} or the temp folder.",
            resolved.display(),
            data.sandbox().display()
        )));
    }
    Ok(resolved)
}

/// Adds a resolved folder (see [`resolve_root_folder`]) as a root. Roots never nest: a file must
/// belong to exactly one, so every holding folder, catalog row and Sync path is unambiguous.
pub fn add_root(connection: &Connection, resolved: &Path) -> anyhow::Result<Root> {
    let path = resolved
        .to_str()
        .with_context(|| format!("{} is not a Unicode path", resolved.display()))?;
    for existing in list_roots(connection)? {
        let other = Path::new(&existing.path);
        // On Windows `path.relative` ignores case, as NTFS does, so the check does too.
        let overlaps = if cfg!(windows) {
            is_within(resolved, other) || is_within(other, resolved)
        } else {
            resolved.starts_with(other) || other.starts_with(resolved)
        };
        if overlaps {
            bail!(RootError(format!(
                "{path} overlaps the root {}.",
                existing.path
            )));
        }
    }
    connection.execute(
        "INSERT INTO roots (path, added_at) VALUES (?1, ?2)",
        params![path, now_ms()],
    )?;
    let id = connection.last_insert_rowid();
    find_root(connection, id)?.ok_or_else(|| RootError("The root was not saved.".into()).into())
}

/// Forgets a root and its catalog. Files on disk are untouched.
pub fn remove_root(connection: &Connection, root_id: RootId) -> anyhow::Result<()> {
    connection.execute("DELETE FROM roots WHERE id = ?1", [root_id])?;
    Ok(())
}

pub fn mark_scanned(connection: &Connection, root_id: RootId) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE roots SET last_scan_at = ?1 WHERE id = ?2",
        params![now_ms(), root_id],
    )?;
    Ok(())
}

/// The stored settings, from any version: each field falls back to its default on its own, and
/// the folders older versions called protected become the preferred folders.
pub fn read_settings(connection: &Connection) -> anyhow::Result<Settings> {
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored.map_or_else(Settings::default, |text| parse_settings(&text)))
}

/// glazier-core's `StoredSettingsSchema`, by hand: anything but a JSON object is the defaults.
pub fn parse_settings(text: &str) -> Settings {
    let defaults = Settings::default();
    let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(text) else {
        return defaults;
    };
    let folders = |key: &str| stored.get(key).and_then(folder_list);
    let text_field = |key: &str| stored.get(key).and_then(Value::as_str);
    Settings {
        preferred_folders: folders("preferredFolders")
            .or_else(|| folders("protectedFolders"))
            .unwrap_or_default(),
        similarity: text_field("similarity")
            .and_then(SimilarityLevel::parse)
            .unwrap_or(defaults.similarity),
        spot_variants: stored
            .get("spotVariants")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.spot_variants),
        reencode_quality: text_field("reencodeQuality")
            .and_then(VideoQuality::parse)
            .unwrap_or(defaults.reencode_quality),
        auto_analyze: stored
            .get("autoAnalyze")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.auto_analyze),
    }
}

/// A list of `{ rootId, dir }`, or `None` when any entry is not one.
fn folder_list(value: &Value) -> Option<Vec<PreferredFolder>> {
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let root_id = entry.get("rootId")?.as_f64()?;
            let positive_integer = root_id > 0.0 && root_id.fract() == 0.0;
            Some(PreferredFolder {
                root_id: positive_integer.then_some(root_id as i64)?,
                dir: entry.get("dir")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

/// Stores the settings as glazier-core does: one JSON row, its keys in the contract's order.
pub fn write_settings(connection: &Connection, settings: &Settings) -> anyhow::Result<()> {
    connection.execute(
        "INSERT INTO settings (key, value) VALUES ('settings', ?1)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [serde_json::to_string(settings)?],
    )?;
    Ok(())
}
