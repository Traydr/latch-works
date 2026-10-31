//! The Rust port against `media-index`'s conformance vectors, which
//! `packages/media-index/src/conformance.test.ts` makes from the TypeScript: the archive scan of a
//! fixed tree, the sync plans, and View's media index as Electron Oriel creates it.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use futures::executor::block_on;
use oriel_core_domain::MediaItem;
use oriel_core_index::{
    ArchiveFileFingerprint, CatalogItem, CatalogMediaType, MediaIndex, RemoteEntrySnapshot,
    ScanArchive, ScanArchiveResult, SkippedArchiveEntry, SyncPlanAction, create_sync_plan,
    escapes_root, fingerprints_match,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;

fn vector_file(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/media-index")
        .join(name)
}

fn read_vectors<T: DeserializeOwned>(name: &str) -> T {
    let file = vector_file(name);
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("{} does not parse: {error}", file.display()))
}

fn scratch(test: &str) -> PathBuf {
    let folder = std::env::temp_dir()
        .join("oriel-core-index-conformance")
        .join(format!("{test}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&folder);
    fs::create_dir_all(&folder).unwrap();
    folder
}

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
struct MatchVector {
    left: ArchiveFileFingerprint,
    right: ArchiveFileFingerprint,
    #[serde(rename = "match")]
    matches: bool,
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
    fingerprints_match: Vec<MatchVector>,
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
fn scans_the_tree_as_the_typescript_does() {
    let vectors: ScanVectors = read_vectors("scan.json");
    let root = scratch("scan");
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
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn compares_fingerprints_and_escapes_as_the_typescript_does() {
    let vectors: ScanVectors = read_vectors("scan.json");
    for vector in &vectors.fingerprints_match {
        assert_eq!(
            fingerprints_match(&vector.left, &vector.right),
            vector.matches,
            "{:?} against {:?}",
            vector.left,
            vector.right
        );
    }
    for vector in &vectors.escapes_root {
        assert_eq!(
            escapes_root(&vector.relative),
            vector.escapes,
            "{:?}",
            vector.relative
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanItemVector {
    action: SyncPlanAction,
    path: String,
    local_path: Option<String>,
    local_size: Option<u64>,
    remote_path: Option<String>,
}

#[derive(Deserialize)]
struct PlanVector {
    counts: HashMap<SyncPlanAction, usize>,
    items: Vec<PlanItemVector>,
}

#[derive(Deserialize)]
struct SyncCase {
    name: String,
    local: Vec<MediaItem>,
    remote: Vec<RemoteEntrySnapshot>,
    plan: PlanVector,
}

#[derive(Deserialize)]
struct SyncVectors {
    cases: Vec<SyncCase>,
}

#[test]
fn plans_syncs_as_the_typescript_does() {
    let vectors: SyncVectors = read_vectors("sync-plan.json");
    assert!(vectors.cases.len() >= 10);
    for case in &vectors.cases {
        let plan = create_sync_plan(&case.local, &case.remote);
        let items: Vec<_> = plan
            .items
            .iter()
            .map(|item| {
                (
                    item.action,
                    item.path.clone(),
                    item.local.as_ref().map(|local| local.path.clone()),
                    item.local.as_ref().map(|local| local.size),
                    item.remote.as_ref().map(|remote| remote.path.clone()),
                )
            })
            .collect();
        let expected: Vec<_> = case
            .plan
            .items
            .iter()
            .map(|item| {
                (
                    item.action,
                    item.path.clone(),
                    item.local_path.clone(),
                    item.local_size,
                    item.remote_path.clone(),
                )
            })
            .collect();
        assert_eq!(items, expected, "{}", case.name);
        for action in [
            SyncPlanAction::Upload,
            SyncPlanAction::Update,
            SyncPlanAction::Keep,
            SyncPlanAction::Delete,
        ] {
            assert_eq!(
                plan.count(action),
                case.plan.counts[&action],
                "{}: {action:?}",
                case.name
            );
        }
    }
}

#[derive(Deserialize, Debug, PartialEq)]
struct MasterRow {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    tbl_name: String,
    sql: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct IndexRowVector {
    path: String,
    root_path: String,
    name: String,
    extension: String,
    media_type: String,
    size: i64,
    mtime_ms: f64,
    mtime_type: String,
    width: Option<f64>,
    height: Option<f64>,
    duration_ms: Option<f64>,
    codec: Option<String>,
    last_seen_scan_id: i64,
}

#[derive(Deserialize)]
struct UserVersion {
    user_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexVectors {
    user_version: Vec<UserVersion>,
    sqlite_master: Vec<MasterRow>,
    media_index: Vec<IndexRowVector>,
}

fn master_and_version(path: &Path) -> (Vec<MasterRow>, i64) {
    let connection = rusqlite::Connection::open(path).unwrap();
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let mut statement = connection
        .prepare("select type, name, tbl_name, sql from sqlite_master order by type, name")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok(MasterRow {
                kind: row.get(0)?,
                name: row.get(1)?,
                tbl_name: row.get(2)?,
                sql: row.get(3)?,
            })
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (rows, version)
}

/// Oriel RS's index has the schema and `user_version` of the one Electron Oriel's statements
/// make, and opens and extends the file the TypeScript made.
#[test]
fn makes_and_reads_views_index_as_electron_oriel_does() {
    let vectors: IndexVectors = read_vectors("view-index.json");
    let folder = scratch("view-index");

    // A fresh Rust index: the same schema, statement text included, and the same version.
    let index = block_on(MediaIndex::open_in(&folder.join("rust"))).unwrap();
    let rust_file = index.path().to_path_buf();
    block_on(index.close()).unwrap();
    let (master, version) = master_and_version(&rust_file);
    assert_eq!(master, vectors.sqlite_master);
    assert_eq!(version, vectors.user_version[0].user_version);

    // The TypeScript's file, opened and read by the Rust.
    let typescript = folder.join("typescript");
    fs::create_dir_all(&typescript).unwrap();
    fs::copy(
        vector_file("view-index.sqlite"),
        typescript.join("media-index.sqlite"),
    )
    .unwrap();
    let index = block_on(MediaIndex::open_in(&typescript)).unwrap();
    let rows = block_on(index.rows()).unwrap();
    let read: Vec<_> = rows
        .iter()
        .map(|row| {
            (
                row.path.clone(),
                row.root_path.clone(),
                row.name.clone(),
                row.extension.clone(),
                row.media_type.clone(),
                row.size,
                row.mtime_ms,
                row.width,
                row.height,
                row.duration_ms,
                row.codec.clone(),
                row.last_seen_scan_id,
            )
        })
        .collect();
    let expected: Vec<_> = vectors
        .media_index
        .iter()
        .map(|row| {
            (
                row.path.clone(),
                row.root_path.clone(),
                row.name.clone(),
                row.extension.clone(),
                row.media_type.clone(),
                row.size,
                row.mtime_ms,
                row.width,
                row.height,
                row.duration_ms,
                row.codec.clone(),
                row.last_seen_scan_id,
            )
        })
        .collect();
    assert_eq!(read, expected);
    let stats = block_on(index.stats()).unwrap();
    assert_eq!((stats.total_items, stats.unique_roots), (2, 1));

    // A new scan of the same root, written by the Rust into the TypeScript's file: it keeps a
    // fractional time as a REAL, as `node:sqlite` stores one, and drops what it did not see.
    let scan = block_on(index.start_scan("/archive".into(), false)).unwrap();
    assert_eq!(scan, 2, "the TypeScript's run was the first");
    let item = CatalogItem::new(
        "/archive/b.jpg".into(),
        "b.jpg".into(),
        "jpg".into(),
        CatalogMediaType::Image,
        4096,
        1_767_268_900_123.456_8,
    );
    block_on(index.upsert_batch("/archive".into(), scan, vec![item].into())).unwrap();
    block_on(index.finish_scan("/archive".into(), scan)).unwrap();
    let rows = block_on(index.rows()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].size, rows[0].mtime_ms),
        (4096, 1_767_268_900_123.456_8)
    );
    let runs = block_on(index.scan_runs()).unwrap();
    assert_eq!(
        runs,
        [
            ("/archive".to_string(), true, "done".to_string()),
            ("/archive".to_string(), false, "done".to_string()),
        ]
    );
    block_on(index.close()).unwrap();
    let connection = rusqlite::Connection::open(typescript.join("media-index.sqlite")).unwrap();
    let kind: String = connection
        .query_row("select typeof(mtime_ms) from media_index", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(kind, vectors.media_index[0].mtime_type);
    drop(connection);

    fs::remove_dir_all(&folder).unwrap();
}

/// A symlink, as the scan meets one. On Windows it needs developer mode or an elevated prompt.
#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[cfg(windows)]
fn symlink(target: &Path, link: &Path) {
    let resolved = link.parent().unwrap().join(target);
    if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    } else {
        std::os::windows::fs::symlink_file(target, link).unwrap();
    }
}
