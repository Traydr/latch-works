//! The differential run's report, made the way glazier-core's `test-support/differential.ts`
//! makes it: Overview's numbers, every catalog row by path, and at each level the similar groups
//! and the duplicate sets with their keepers. Both reports name files by path, so they compare
//! whatever ids the two catalogs gave.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use futures::executor::block_on;
use oriel_core_tidy::TidyEngine;
use oriel_core_tidy::contract::{
    DuplicateScope, DuplicateSet, DuplicateSetRequest, RootId, SimilarityLevel, is_close_call,
};
use oriel_core_tidy::duplicates::compute_similar_clusters;
use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// The archive's manifest: every file with the mtime a copy carries, and the empty folders.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub files: Vec<ManifestFile>,
    pub empty_folders: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub mtime_ms: f64,
}

fn at(root: &Path, rel_path: &str) -> PathBuf {
    rel_path
        .split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn set_mtime(path: &Path, mtime: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .and_then(|file| file.set_modified(mtime))
        .unwrap_or_else(|error| panic!("dating {}: {error}", path.display()));
}

/// Copies the archive as the manifest describes it, dates included, as glazier-core's
/// `copyArchive` does.
pub fn copy_archive(source: &Path, manifest: &Manifest, target: &Path) {
    for folder in &manifest.empty_folders {
        fs::create_dir_all(at(target, folder)).unwrap();
    }
    for file in &manifest.files {
        let to = at(target, &file.path);
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(at(source, &file.path), &to)
            .unwrap_or_else(|error| panic!("copying {}: {error}", file.path));
        set_mtime(
            &to,
            SystemTime::UNIX_EPOCH + Duration::from_millis(file.mtime_ms as u64),
        );
    }
}

/// Copies a folder as `fs.cp` with `preserveTimestamps` does, for comparing any folder.
pub fn copy_folder(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        let to = target.join(entry.file_name());
        if kind.is_dir() {
            copy_folder(&entry.path(), &to);
        } else if kind.is_file() {
            fs::copy(entry.path(), &to).unwrap();
            let modified = entry.metadata().unwrap().modified().unwrap();
            // `fs.cp` sets whole milliseconds.
            let since = modified.duration_since(SystemTime::UNIX_EPOCH).unwrap();
            set_mtime(
                &to,
                SystemTime::UNIX_EPOCH + Duration::from_millis(since.as_millis() as u64),
            );
        }
    }
}

const FILES_SQL: &str =
    "SELECT f.id, f.rel_path, f.kind, f.format, f.ext_mismatch, f.is_junk, f.width,
    f.height, f.frames, f.has_alpha, f.duration_ms, f.video_codec, f.audio_codec,
    f.audio_streams, f.bitrate, f.probe_error IS NOT NULL AS probe_failed, f.head_hash, f.sha256,
    f.fingerprint, f.fingerprint_error IS NOT NULL AS fingerprint_failed, f.loudness_version,
    f.loudness_max_db, d.print AS detail
  FROM files f LEFT JOIN file_details d ON d.file_id = f.id
  WHERE f.root_id = ?1 ORDER BY f.rel_path";

fn json_of(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => json!(number),
        ValueRef::Real(number) => json!(number),
        ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
        ValueRef::Blob(bytes) => json!(
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ),
    }
}

fn catalog_files(engine: &TidyEngine, root_id: RootId) -> (Vec<Value>, HashMap<i64, String>) {
    block_on(engine.catalog().call(move |connection| {
        let mut statement = connection.prepare(FILES_SQL)?;
        let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let mut rows = statement.query([root_id])?;
        let mut files = Vec::new();
        let mut paths = HashMap::new();
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let rel_path: String = row.get(1)?;
            paths.insert(id, rel_path);
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate().skip(1) {
                object.insert(name.clone(), json_of(row.get_ref(index)?));
            }
            files.push(Value::Object(object));
        }
        Ok((files, paths))
    }))
    .unwrap()
}

fn report_set(set: &DuplicateSet, path_of: &dyn Fn(i64) -> String) -> Value {
    let key = match set.key.strip_prefix("similar:") {
        Some(id) => format!("similar:{}", path_of(id.parse().unwrap())),
        None => set.key.clone(),
    };
    json!({
        "key": key,
        "kind": set.kind,
        "versions": set.versions.iter().map(|version| {
            version.files.iter().map(|file| file.rel_path.clone()).collect::<Vec<_>>()
        }).collect::<Vec<_>>(),
        "pictures": set.pictures,
        "keep": set.keep.iter().map(|&id| path_of(id)).collect::<Vec<_>>(),
        "keepReason": set.keep_reason,
        "reclaimableBytes": set.reclaimable_bytes,
        "hardLinked": set.hard_linked_ids.iter().map(|&id| path_of(id)).collect::<Vec<_>>(),
        "distance": set.distance,
        "closeCall": is_close_call(set),
    })
}

/// What the engine made of a root, as glazier-core's `differentialReport` writes it.
pub fn report(engine: &TidyEngine, root_id: RootId) -> Value {
    let mut overview = serde_json::to_value(block_on(engine.overview(root_id)).unwrap()).unwrap();
    overview.as_object_mut().unwrap().remove("lastScanAt");
    let (files, paths) = catalog_files(engine, root_id);
    let path_of = |id: i64| {
        paths
            .get(&id)
            .cloned()
            .unwrap_or_else(|| panic!("No catalog row for file {id}"))
    };

    let mut levels = Map::new();
    for level in SimilarityLevel::ALL {
        let level = *level;
        let groups =
            block_on(engine.catalog().call(move |connection| {
                compute_similar_clusters(connection, Some(root_id), level)
            }))
            .unwrap();
        let page = |scope| {
            block_on(engine.duplicate_sets(DuplicateSetRequest {
                root_id: Some(root_id),
                offset: 0,
                limit: 500,
                level,
                scope,
                dismissed: false,
            }))
            .unwrap()
        };
        let open = page(DuplicateScope::All);
        let variants = page(DuplicateScope::Variants);
        levels.insert(
            level.as_str().to_owned(),
            json!({
                "groups": groups.iter().map(|group| json!({
                    "kind": group.kind,
                    "distance": group.distance,
                    "files": group.ids.iter().map(|&id| path_of(id)).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
                "counts": open.counts,
                "total": open.total,
                "reclaimableBytes": open.reclaimable_bytes,
                "openReclaimableBytes": open.open_reclaimable_bytes,
                "fingerprinted": open.fingerprinted,
                "fingerprintable": open.fingerprintable,
                "compared": open.compared,
                "comparable": open.comparable,
                "sets": open.sets.iter().map(|set| report_set(set, &path_of)).collect::<Vec<_>>(),
                "variants": variants.sets.iter().map(|set| report_set(set, &path_of)).collect::<Vec<_>>(),
            }),
        );
    }
    json!({ "overview": overview, "files": files, "levels": levels })
}

/// Where two reports differ, by JSON path; numbers compare by value, so `3` equals `3.0`.
pub fn differences(expected: &Value, actual: &Value) -> Vec<String> {
    let mut found = Vec::new();
    compare(expected, actual, "$", &mut found);
    found
}

fn compare(expected: &Value, actual: &Value, path: &str, found: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(left), Value::Number(right)) => {
            if left.as_f64() != right.as_f64() {
                found.push(format!("{path}: {left} ≠ {right}"));
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            if left.len() != right.len() {
                found.push(format!(
                    "{path}: {} items ≠ {} items: {} ≠ {}",
                    left.len(),
                    right.len(),
                    expected,
                    actual
                ));
                return;
            }
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                compare(left, right, &format!("{path}[{index}]"), found);
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            for (key, value) in left {
                match right.get(key) {
                    Some(other) => compare(value, other, &format!("{path}.{key}"), found),
                    None => found.push(format!("{path}.{key}: missing")),
                }
            }
            for key in right.keys().filter(|key| !left.contains_key(*key)) {
                found.push(format!("{path}.{key}: not expected"));
            }
        }
        _ => {
            if expected != actual {
                found.push(format!("{path}: {expected} ≠ {actual}"));
            }
        }
    }
}

/// Scans and analyses `archive` with a fresh engine whose data lives in `data`, then reports it
/// with Spot variants off and on, as glazier-core's differential test does.
pub fn run(archive: &Path, data: &Path, media: oriel_core_tidy::passes::Media) -> Value {
    use oriel_core_paths::DataRoot;
    use oriel_core_tidy::passes::Quiet;

    let data_root = DataRoot::at(data.to_path_buf()).unwrap();
    let engine = block_on(TidyEngine::open_with(
        data_root.clone(),
        data_root.tidy().join("catalog.sqlite"),
        media,
    ))
    .unwrap();
    let root = block_on(engine.add_root(archive)).unwrap();
    // The scan, then the background analysis it queues, as glazier-core's harness waits for both.
    let scanned = engine.scan_blocking(root.id, &Quiet::new()).unwrap();
    engine
        .follow_up_blocking(&scanned.follow_up, &Quiet::new())
        .unwrap();
    let off = report(&engine, root.id);

    let mut settings = block_on(engine.settings()).unwrap();
    settings.spot_variants = true;
    let update = block_on(engine.update_settings(settings)).unwrap();
    assert!(update.analyze, "turning Spot variants on asks for analysis");
    engine.analyze_blocking(root.id, &Quiet::new()).unwrap();
    let on = report(&engine, root.id);
    block_on(engine.catalog().clone().close()).unwrap();
    json!({ "off": off, "on": on })
}
