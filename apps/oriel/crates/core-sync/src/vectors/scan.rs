//! `scan.json`: what the scan lists, skips and fingerprints over a tree on disk, in its order,
//! hashed or not, and which relative paths leave the root.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use oriel_core_domain::MediaItem;
use serde::Deserialize;

use super::{read_vectors, symlink};
use crate::scan::{ScanArchive, ScanArchiveResult, SkippedArchiveEntry, escapes_root};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TreeEntry {
    File {
        path: String,
        content: String,
        minutes: u64,
    },
    Directory {
        path: String,
    },
    Symlink {
        path: String,
        target: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintVector {
    path: String,
    mtime_ms: f64,
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanVector {
    items: Vec<MediaItem>,
    skipped: usize,
    skipped_entries: Vec<SkippedArchiveEntry>,
    fingerprints: Vec<FingerprintVector>,
}

#[derive(Deserialize)]
struct EscapeVector {
    relative: String,
    escapes: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanVectors {
    tree_epoch_seconds: u64,
    tree: Vec<TreeEntry>,
    scan: ScanVector,
    hashed: ScanVector,
    escapes_root: Vec<EscapeVector>,
}

/// Makes the vectors' tree under `root`, with each file's modified time three quarters into its
/// second, as the TypeScript sets it.
fn build_tree(root: &Path, vectors: &ScanVectors) {
    for entry in &vectors.tree {
        match entry {
            TreeEntry::Directory { path } => fs::create_dir_all(root.join(path)).unwrap(),
            TreeEntry::File {
                path,
                content,
                minutes,
            } => {
                let target = root.join(path);
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(&target, content).unwrap();
                let modified = UNIX_EPOCH
                    + Duration::from_secs(vectors.tree_epoch_seconds + minutes * 60)
                    + Duration::from_millis(750);
                fs::File::options()
                    .write(true)
                    .open(&target)
                    .unwrap()
                    .set_modified(modified)
                    .unwrap();
            }
            TreeEntry::Symlink { path, target } => {
                let link = root.join(path);
                fs::create_dir_all(link.parent().unwrap()).unwrap();
                symlink(Path::new(target), &link);
            }
        }
    }
}

fn check_scan(what: &str, result: &ScanArchiveResult, expected: &ScanVector) {
    assert_eq!(result.items, expected.items, "{what}: the items");
    assert_eq!(
        result.skipped, expected.skipped,
        "{what}: the skipped count"
    );
    assert_eq!(
        result.skipped_entries, expected.skipped_entries,
        "{what}: the skipped entries"
    );
    let fingerprints: BTreeMap<&str, (f64, u64)> = result
        .fingerprints
        .iter()
        .map(|(path, fingerprint)| (path.as_str(), (fingerprint.mtime_ms, fingerprint.size)))
        .collect();
    let expected_fingerprints: BTreeMap<&str, (f64, u64)> = expected
        .fingerprints
        .iter()
        .map(|fingerprint| {
            (
                fingerprint.path.as_str(),
                (fingerprint.mtime_ms, fingerprint.size),
            )
        })
        .collect();
    assert_eq!(
        fingerprints, expected_fingerprints,
        "{what}: the fingerprints"
    );
}

#[test]
#[cfg_attr(
    windows,
    ignore = "Windows drops the trailing dot of the vectors' `trailing.`"
)]
fn scans_as_lockstep_core_does() {
    let vectors: ScanVectors = read_vectors("scan.json");
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("scan");
    build_tree(&root, &vectors);

    check_scan(
        "the default pools",
        &ScanArchive::new(&root).run().unwrap(),
        &vectors.scan,
    );
    check_scan(
        "pools of one",
        &ScanArchive::new(&root)
            .directory_concurrency(1)
            .file_concurrency(1)
            .run()
            .unwrap(),
        &vectors.scan,
    );
    check_scan(
        "pools of sixteen",
        &ScanArchive::new(&root)
            .directory_concurrency(16)
            .file_concurrency(16)
            .run()
            .unwrap(),
        &vectors.scan,
    );
    check_scan(
        "hashed",
        &ScanArchive::new(&root).hash_files(true).run().unwrap(),
        &vectors.hashed,
    );
    assert!(
        ScanArchive::new(&root)
            .directory_concurrency(17)
            .run()
            .is_err(),
        "concurrency past sixteen is refused"
    );
}

#[test]
#[cfg_attr(windows, ignore = "the vectors hold POSIX relative paths (`../a.jpg`)")]
fn tells_paths_outside_the_root_as_lockstep_core_does() {
    let vectors: ScanVectors = read_vectors("scan.json");
    for vector in &vectors.escapes_root {
        assert_eq!(
            escapes_root(&vector.relative),
            vector.escapes,
            "{:?}",
            vector.relative
        );
    }
}
