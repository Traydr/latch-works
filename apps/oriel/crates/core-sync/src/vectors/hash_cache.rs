//! `hash-cache.json`: where each source's cache lives, what a cache file reads as, which cached
//! hashes a scan's fingerprints keep, and what a saved cache holds.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::{media_item, read_vectors};
use crate::hash_cache::{hash_cache_path, load_hash_cache};
use crate::scan::{ArchiveFileFingerprint, fingerprints_match};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Fingerprint {
    ctime_ms: Option<f64>,
    mtime_ms: f64,
    size: u64,
}

impl From<Fingerprint> for ArchiveFileFingerprint {
    fn from(fingerprint: Fingerprint) -> Self {
        Self {
            ctime_ms: fingerprint.ctime_ms,
            mtime_ms: fingerprint.mtime_ms,
            size: fingerprint.size,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashCacheVectors {
    cache_root: String,
    cache_paths: Vec<CachePathCase>,
    reads: Vec<ReadCase>,
    fingerprints: Vec<FingerprintCase>,
    hydrate: HydrateCase,
    save: SaveCase,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachePathCase {
    source_root: String,
    file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadCase {
    name: String,
    source_root: String,
    file: String,
    entries: Option<Value>,
}

#[derive(Deserialize)]
struct FingerprintCase {
    left: Fingerprint,
    right: Fingerprint,
    #[serde(rename = "match")]
    matches: bool,
}

#[derive(Deserialize)]
struct HydrateCase {
    entries: Value,
    items: Vec<HydrateItem>,
    hits: usize,
    hashes: Vec<Option<String>>,
}

#[derive(Deserialize)]
struct HydrateItem {
    path: String,
    fingerprint: Option<Fingerprint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveCase {
    source_root: String,
    sets: Vec<SetCase>,
    retain: Vec<String>,
    saved: Value,
}

#[derive(Deserialize)]
struct SetCase {
    path: String,
    fingerprint: Fingerprint,
    sha256: String,
}

#[test]
#[cfg_attr(
    windows,
    ignore = "the vectors hold the POSIX paths Node writes on macOS"
)]
fn keeps_hash_caches_as_lockstep_core_does() {
    let vectors: HashCacheVectors = read_vectors("hash-cache.json");
    // The cache's folder, whose version folder the vectors' files sit in.
    let folder = Path::new(&vectors.cache_root).parent().unwrap();

    for case in &vectors.cache_paths {
        assert_eq!(
            hash_cache_path(Path::new(&case.source_root), folder),
            PathBuf::from(&case.file),
            "the cache file of {:?}",
            case.source_root
        );
    }

    // Each file TypeScript wrote, read by Rust.
    let scratch = tempfile::tempdir().unwrap();
    for case in vectors.reads {
        let root = scratch.path().join("reads");
        let file = hash_cache_path(Path::new(&case.source_root), &root);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, &case.file).unwrap();
        let loaded = load_hash_cache(Path::new(&case.source_root), &root);
        let entries = loaded.warning.is_none().then(|| {
            // A loaded cache shows its entries as it saves them.
            let saved: Value = serde_json::from_str(&loaded.cache.to_json()).unwrap();
            saved["entries"].clone()
        });
        assert_eq!(entries, case.entries, "{}", case.name);
        fs::remove_file(&file).unwrap();
    }

    for case in vectors.fingerprints {
        assert_eq!(
            fingerprints_match(&case.left.into(), &case.right.into()),
            case.matches
        );
    }

    let hydrate = vectors.hydrate;
    let source_root = Path::new("/Volumes/Archive");
    let root = scratch.path().join("hydrate");
    let file = hash_cache_path(source_root, &root);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let written = serde_json::json!({
        "entries": hydrate.entries,
        "sourceRoot": source_root,
        "version": 1,
    });
    fs::write(&file, written.to_string()).unwrap();
    let loaded = load_hash_cache(source_root, &root);
    assert_eq!(loaded.warning, None);
    let fingerprints: HashMap<String, ArchiveFileFingerprint> = hydrate
        .items
        .iter()
        .filter_map(|item| Some((item.path.clone(), item.fingerprint?.into())))
        .collect();
    let items = hydrate
        .items
        .iter()
        .map(|item| media_item(&item.path, 1, None))
        .collect();
    let (items, hits) = loaded.cache.hydrate(items, &fingerprints);
    assert_eq!(hits, hydrate.hits);
    assert_eq!(
        items
            .iter()
            .map(|item| item.sha256.clone())
            .collect::<Vec<_>>(),
        hydrate.hashes
    );

    // A cache Rust saves reads as the one TypeScript saved.
    let save = vectors.save;
    let root = scratch.path().join("save");
    let source_root = Path::new(&save.source_root);
    let mut cache = load_hash_cache(source_root, &root).cache;
    for set in &save.sets {
        cache
            .set(&set.path, &set.fingerprint.into(), &set.sha256)
            .unwrap();
    }
    cache.retain(save.retain.iter().map(String::as_str));
    cache.save().unwrap();
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(hash_cache_path(source_root, &root)).unwrap())
            .unwrap();
    assert_eq!(saved, save.saved);
}
