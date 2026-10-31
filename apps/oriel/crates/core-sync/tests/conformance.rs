//! lockstep-core's conformance vectors (`conformance/lockstep-core/*.json`), made by
//! `packages/lockstep-core/src/conformance.test.ts`: the Rust must plan, cache, scan and check as
//! the TypeScript does. A failure is a difference between the two implementations; after a
//! deliberate change on the TypeScript side, rewrite the vectors with
//! `ORIEL_UPDATE_VECTORS=1 pnpm --filter @latch-works/lockstep-core test` and port it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use oriel_core_domain::{
    MediaItem, detect_media_type, get_base_name, get_extension, get_parent_path,
};
use oriel_core_index::{
    ArchiveFileFingerprint, RemoteEntrySnapshot, ScanArchive, SyncPlanAction, create_sync_plan,
    fingerprints_match,
};
use oriel_core_sync::{
    DoctorOptions, HashCache, HashCacheEntry, HashMode, RunEvent, cache_root,
    content_type_for_extension, doctor, hash_cache_path, load_hash_cache, resolve_hash_mode,
    resolve_local_file_path, resolve_upload_concurrency, select_changed_items, select_delete_items,
    select_planning_hash_paths, select_upload_update_items,
};
use oriel_runtime::CancelToken;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn read_vectors<T: DeserializeOwned>(file_name: &str) -> T {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance/lockstep-core")
        .join(file_name);
    let json = fs::read_to_string(&file)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", file.display()));
    serde_json::from_str(&json)
        .unwrap_or_else(|error| panic!("{} does not parse: {error}", file.display()))
}

/// `mediaItem` in the TypeScript suite: a scanned file, and its hash when one is known.
fn media_item(path: &str, size: u64, sha256: Option<&str>) -> MediaItem {
    let name = get_base_name(path);
    MediaItem {
        id: sha256.unwrap_or(path).to_owned(),
        path: path.to_owned(),
        parent_path: get_parent_path(path),
        extension: get_extension(&name),
        media_type: detect_media_type(&name),
        name,
        size,
        mtime_ms: 1_700_000_000_000.0,
        sha256: sha256.map(str::to_owned),
        width: None,
        height: None,
        duration_ms: None,
        page_count: None,
        thumbnail_url: None,
        original_url: None,
    }
}

#[derive(Deserialize)]
struct Entry {
    path: String,
    size: u64,
    sha256: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PlanItem {
    action: String,
    path: String,
    local_path: Option<String>,
    remote_path: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Selection {
    max_changes: Option<usize>,
    paths: Vec<String>,
    omitted_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashPaths {
    all: Vec<String>,
    remote_aware: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCase {
    name: String,
    local: Vec<Entry>,
    remote: Vec<Entry>,
    items: Vec<PlanItem>,
    counts: oriel_core_sync::PlanCounts,
    hash_paths: HashPaths,
    push: Vec<Selection>,
    prune: Vec<Selection>,
    planned_local_paths: Vec<String>,
}

#[derive(Deserialize)]
struct PlanVectors {
    cases: Vec<PlanCase>,
}

fn action_name(action: SyncPlanAction) -> &'static str {
    match action {
        SyncPlanAction::Upload => "upload",
        SyncPlanAction::Update => "update",
        SyncPlanAction::Keep => "keep",
        SyncPlanAction::Delete => "delete",
    }
}

#[test]
fn plans_as_lockstep_core_does() {
    let vectors: PlanVectors = read_vectors("plan.json");
    for case in vectors.cases {
        let local: Vec<MediaItem> = case
            .local
            .iter()
            .map(|entry| media_item(&entry.path, entry.size, entry.sha256.as_deref()))
            .collect();
        let remote: Vec<RemoteEntrySnapshot> = case
            .remote
            .iter()
            .map(|entry| RemoteEntrySnapshot {
                path: entry.path.clone(),
                sha256: entry.sha256.clone(),
                size: entry.size,
            })
            .collect();
        let plan = create_sync_plan(&local, &remote);
        let items: Vec<PlanItem> = plan
            .items
            .iter()
            .map(|item| PlanItem {
                action: action_name(item.action).to_owned(),
                path: item.path.clone(),
                local_path: item.local.as_ref().map(|local| local.path.clone()),
                remote_path: item.remote.as_ref().map(|remote| remote.path.clone()),
            })
            .collect();
        assert_eq!(items, case.items, "{}: the plan's items", case.name);

        let count = |action| {
            plan.items
                .iter()
                .filter(|item| item.action == action)
                .count()
        };
        let counts = oriel_core_sync::PlanCounts {
            delete: count(SyncPlanAction::Delete),
            keep: count(SyncPlanAction::Keep),
            update: count(SyncPlanAction::Update),
            upload: count(SyncPlanAction::Upload),
        };
        assert_eq!(counts, case.counts, "{}: the counts", case.name);

        assert_eq!(
            select_planning_hash_paths(HashMode::All, &local, &remote),
            case.hash_paths.all,
            "{}: what `all` hashes",
            case.name
        );
        assert_eq!(
            select_planning_hash_paths(HashMode::RemoteAware, &local, &remote),
            case.hash_paths.remote_aware,
            "{}: what `remote-aware` hashes",
            case.name
        );

        let changed = select_changed_items(&plan.items);
        let select = |pick: &dyn Fn(Option<usize>) -> (Vec<String>, usize)| {
            [None, Some(1), Some(2)]
                .into_iter()
                .map(|max_changes| {
                    let (paths, omitted_count) = pick(max_changes);
                    Selection {
                        max_changes,
                        paths,
                        omitted_count,
                    }
                })
                .collect::<Vec<_>>()
        };
        let push = select(&|max| {
            let (items, omitted) = select_upload_update_items(&changed, max);
            (
                items.iter().map(|item| item.path.clone()).collect(),
                omitted,
            )
        });
        let prune = select(&|max| {
            let (items, omitted) = select_delete_items(&changed, max);
            (
                items.iter().map(|item| item.path.clone()).collect(),
                omitted,
            )
        });
        assert_eq!(push, case.push, "{}: what a push takes", case.name);
        assert_eq!(prune, case.prune, "{}: what a prune takes", case.name);

        let planned_local: Vec<String> = plan
            .items
            .iter()
            .filter(|item| item.action != SyncPlanAction::Delete)
            .map(|item| item.path.clone())
            .collect();
        assert_eq!(planned_local, case.planned_local_paths, "{}", case.name);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulesVectors {
    content_types: Vec<ContentTypeCase>,
    registrations: Vec<RegistrationCase>,
    upload_concurrency: Vec<ConcurrencyCase>,
    hash_modes: Vec<HashModeCase>,
    local_paths: Vec<LocalPathCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentTypeCase {
    extension: String,
    content_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationCase {
    logical_path: String,
    filename: String,
    extension: String,
    content_type: String,
}

#[derive(Deserialize)]
struct ConcurrencyCase {
    value: Option<f64>,
    resolved: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashModeCase {
    hash_files: Option<bool>,
    hash_mode: Option<HashMode>,
    default_mode: Option<HashMode>,
    resolved: HashMode,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalPathCase {
    archive_path: String,
    resolved: Option<String>,
}

#[test]
fn applies_lockstep_cores_rules() {
    let vectors: RulesVectors = read_vectors("rules.json");
    for case in vectors.content_types {
        assert_eq!(
            content_type_for_extension(&case.extension),
            case.content_type,
            "{}",
            case.extension
        );
    }
    for case in vectors.registrations {
        let filename = get_base_name(&case.logical_path);
        let extension = get_extension(&filename);
        assert_eq!(filename, case.filename, "{}", case.logical_path);
        assert_eq!(extension, case.extension, "{}", case.logical_path);
        assert_eq!(content_type_for_extension(&extension), case.content_type);
    }
    for case in vectors.upload_concurrency {
        // A fraction or a negative never reaches Rust's `usize`; it is refused as TypeScript
        // refuses it.
        let resolved = match case.value {
            None => resolve_upload_concurrency(None).ok(),
            Some(value) if value >= 0.0 && value.fract() == 0.0 => {
                resolve_upload_concurrency(Some(value as usize)).ok()
            }
            Some(_) => None,
        };
        assert_eq!(
            resolved, case.resolved,
            "upload concurrency {:?}",
            case.value
        );
    }
    for case in vectors.hash_modes {
        assert_eq!(
            resolve_hash_mode(case.hash_files, case.hash_mode, case.default_mode),
            case.resolved
        );
    }
    for case in vectors.local_paths {
        let resolved = resolve_local_file_path(Path::new("/archive/root"), &case.archive_path)
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
        assert_eq!(resolved, case.resolved, "{:?}", case.archive_path);
    }
}

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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    ctime_ms: Option<f64>,
    mtime_ms: f64,
    path: String,
    sha256: String,
    size: u64,
}

impl From<CacheEntry> for HashCacheEntry {
    fn from(entry: CacheEntry) -> Self {
        Self {
            ctime_ms: entry.ctime_ms,
            mtime_ms: entry.mtime_ms,
            path: entry.path,
            sha256: entry.sha256,
            size: entry.size,
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
    entries: Option<Vec<CacheEntry>>,
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
    entries: Vec<CacheEntry>,
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
fn keeps_hash_caches_as_lockstep_core_does() {
    let vectors: HashCacheVectors = read_vectors("hash-cache.json");

    for case in &vectors.cache_paths {
        assert_eq!(
            hash_cache_path(Path::new(&case.source_root), Path::new(&vectors.cache_root)),
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
        let expected = case.entries.map(|entries| {
            serde_json::to_value(
                entries
                    .into_iter()
                    .map(HashCacheEntry::from)
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        });
        assert_eq!(entries, expected, "{}", case.name);
        fs::remove_file(&file).unwrap();
    }

    for case in vectors.fingerprints {
        assert_eq!(
            fingerprints_match(&case.left.into(), &case.right.into()),
            case.matches
        );
    }

    let hydrate = vectors.hydrate;
    let cache = HashCache::new(
        scratch.path().join("hydrate.json"),
        "/Volumes/Archive".to_owned(),
        hydrate.entries.into_iter().map(Into::into).collect(),
    );
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
    let (items, hits) = cache.hydrate(items, &fingerprints);
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
    let path = scratch.path().join("save/cache.json");
    let mut cache = HashCache::new(path.clone(), save.source_root, Vec::new());
    for set in &save.sets {
        cache
            .set(&set.path, &set.fingerprint.into(), &set.sha256)
            .unwrap();
    }
    cache.retain(&save.retain.iter().cloned().collect());
    cache.save().unwrap();
    let saved: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved, save.saved);
}

#[test]
fn caches_under_their_version_folder() {
    let root = cache_root(Path::new("/data/hash-cache"));
    assert_eq!(root, PathBuf::from("/data/hash-cache/v1"));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanVectors {
    tree: Vec<TreeEntry>,
    items: Vec<ScanItem>,
    skipped_entries: Vec<Value>,
    skipped: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeEntry {
    path: String,
    kind: String,
    size: Option<u64>,
    mtime_ms: Option<f64>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ScanItem {
    path: String,
    parent_path: String,
    name: String,
    extension: String,
    media_type: String,
    size: u64,
    mtime_ms: f64,
}

/// The tree on disk, in a temp folder: files of the given sizes and modified times, folders, and
/// symlinks to a file outside the tree.
fn make_tree(root: &Path, tree: &[TreeEntry]) {
    let outside = root.parent().unwrap().join("outside.jpg");
    fs::write(&outside, b"outside").unwrap();
    for entry in tree {
        let path = root.join(&entry.path);
        match entry.kind.as_str() {
            "directory" => fs::create_dir_all(&path).unwrap(),
            "file" => {
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, vec![b'x'; entry.size.unwrap() as usize]).unwrap();
                let modified = UNIX_EPOCH + Duration::from_millis(entry.mtime_ms.unwrap() as u64);
                fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(modified)
                    .unwrap();
            }
            "symlink" => symlink(&outside, &path),
            other => panic!("unknown kind {other}"),
        }
    }
}

#[test]
fn scans_as_lockstep_core_does() {
    let vectors: ScanVectors = read_vectors("scan.json");
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("scan-root");
    fs::create_dir_all(&root).unwrap();
    make_tree(&root, &vectors.tree);

    let scanned = ScanArchive::new(&root).run().unwrap();
    let items: Vec<ScanItem> = scanned
        .items
        .iter()
        .map(|item| ScanItem {
            path: item.path.clone(),
            parent_path: item.parent_path.clone(),
            name: item.name.clone(),
            extension: item.extension.clone(),
            media_type: serde_json::to_value(item.media_type)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            size: item.size,
            mtime_ms: item.mtime_ms,
        })
        .collect();
    assert_eq!(items, vectors.items);
    assert_eq!(
        serde_json::to_value(&scanned.skipped_entries).unwrap(),
        Value::Array(vectors.skipped_entries)
    );
    assert_eq!(scanned.skipped, vectors.skipped);
}

#[derive(Deserialize)]
struct DoctorVectors {
    cases: Vec<DoctorCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCase {
    name: String,
    options: DoctorCaseOptions,
    checks: Vec<oriel_core_sync::DoctorCheck>,
    ok: bool,
    summary: DoctorSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCaseOptions {
    source_root: Option<String>,
    api_url: Option<String>,
    api_token: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct DoctorSummary {
    message: String,
    status: String,
    failed: usize,
}

#[test]
fn checks_as_lockstep_cores_doctor_does() {
    let vectors: DoctorVectors = read_vectors("doctor.json");
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("doctor");
    fs::create_dir_all(root.join("archive")).unwrap();
    fs::write(root.join("file.jpg"), "x").unwrap();
    let root_text = root.to_string_lossy().into_owned();

    for case in vectors.cases {
        let summary = std::sync::Arc::new(std::sync::Mutex::new(None));
        let recorded = summary.clone();
        let observer: oriel_core_sync::Observer = std::sync::Arc::new(move |event| {
            if let RunEvent::Complete(summary) = event {
                *recorded.lock().unwrap() = Some(DoctorSummary {
                    message: summary.message.unwrap_or_default(),
                    status: summary.status.as_str().to_owned(),
                    failed: summary.failed,
                });
            }
        });
        let options = DoctorOptions {
            source_root: case
                .options
                .source_root
                .map(|root| root.replace("<root>", &root_text)),
            api_url: case.options.api_url,
            api_token: case.options.api_token,
        };
        let result =
            futures::executor::block_on(doctor(options, Some(&observer), &CancelToken::new()));
        let checks: Vec<_> = result
            .checks
            .into_iter()
            .map(|mut check| {
                check.detail = check
                    .detail
                    .map(|detail| detail.replace(&root_text, "<root>"));
                check
            })
            .collect();
        assert_eq!(checks, case.checks, "{}", case.name);
        assert_eq!(result.ok, case.ok, "{}", case.name);
        assert_eq!(
            summary.lock().unwrap().take(),
            Some(case.summary),
            "{}",
            case.name
        );
    }
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
