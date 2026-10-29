//! Planning, from `plan-sync.ts`: the source folder scanned, its hashes taken from the cache or
//! the files as the hash mode asks, and paired with Pane View's snapshot into uploads, updates,
//! keeps and deletes (`media-index`'s `createSyncPlan`, in `oriel-core-index`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::Context as _;
use oriel_core_domain::{MediaItem, pair_sync_paths};
use oriel_core_index::{
    HashArchiveItems, RemoteEntrySnapshot, ScanArchive, ScanArchiveProgress, SkippedArchiveEntry,
    SyncPlanAction, SyncPlanItem, create_sync_plan,
};
use oriel_runtime::{CancelToken, Cancelled};
use serde::{Deserialize, Serialize};

use crate::api::PaneViewClient;
use crate::events::{
    Observer, PlanCounts, RunAction, RunEvent, RunStatus, RunSummary, emit, status,
};
use crate::format::format_count;
use crate::hash_cache::load_hash_cache;

/// Which files a plan hashes, `HashMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HashMode {
    /// Every file without a cached hash.
    All,
    /// None: sizes alone decide, as Sync's Plan button does.
    None,
    /// Only files whose paired remote entry has a hash and the same size, as a push plans.
    RemoteAware,
}

/// A plan, `LockstepPlan`.
#[derive(Clone, Debug, PartialEq)]
pub struct LockstepPlan {
    pub counts: PlanCounts,
    pub items: Vec<SyncPlanItem>,
    pub skipped: usize,
    pub skipped_entries: Vec<SkippedArchiveEntry>,
    pub source_root: PathBuf,
    pub total_bytes: u64,
    pub total_files: usize,
}

impl LockstepPlan {
    /// The bytes a push would send: the local sizes of the uploads and updates.
    pub fn push_bytes(&self) -> u64 {
        self.items
            .iter()
            .filter(|item| matches!(item.action, SyncPlanAction::Upload | SyncPlanAction::Update))
            .filter_map(|item| item.local.as_ref().map(|local| local.size))
            .sum()
    }
}

/// `PlanSyncOptions`, less the snapshot file the CLI reads, which Sync never uses.
#[derive(Clone, Debug)]
pub struct PlanOptions {
    pub source_root: PathBuf,
    /// The cache's version folder, `cache_root(DataRoot::hash_cache())`.
    pub hash_cache_root: PathBuf,
    pub hash_mode: HashMode,
    pub directory_concurrency: Option<usize>,
    pub file_concurrency: Option<usize>,
}

pub(crate) fn counts_of(items: &[SyncPlanItem]) -> PlanCounts {
    let count = |action| items.iter().filter(|item| item.action == action).count();
    PlanCounts {
        delete: count(SyncPlanAction::Delete),
        keep: count(SyncPlanAction::Keep),
        update: count(SyncPlanAction::Update),
        upload: count(SyncPlanAction::Upload),
    }
}

/// `planSync`: compares the source folder with Pane View's snapshot (or with nothing, without a
/// client). Run it on the tokio thread; the scan and the hashing move to blocking threads.
pub async fn plan_sync(
    options: PlanOptions,
    client: Option<&PaneViewClient>,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<LockstepPlan> {
    cancel.check()?;
    let mut remote = Vec::new();
    if let Some(client) = client {
        status(observer, "Fetching remote sync snapshot...");
        remote = client.fetch_snapshot(Some(cancel)).await?;
        status(
            observer,
            format!(
                "Remote snapshot loaded ({} entries).",
                format_count(remote.len())
            ),
        );
    }
    cancel.check()?;
    status(observer, "Indexing local archive...");

    let observer_for_scan = observer.cloned();
    let cancel_for_scan = cancel.clone();
    let remote_for_scan = remote.clone();
    let (local, scan) = tokio::task::spawn_blocking(move || {
        scan_and_hash(
            &options,
            &remote_for_scan,
            observer_for_scan.as_ref(),
            &cancel_for_scan,
        )
    })
    .await
    .context("the scan stopped")??;
    cancel.check()?;

    let plan = create_sync_plan(&local, &remote);
    let counts = counts_of(&plan.items);
    let result = LockstepPlan {
        counts,
        items: plan.items,
        skipped: scan.skipped,
        skipped_entries: scan.skipped_entries,
        source_root: scan.source_root,
        total_bytes: local.iter().map(|item| item.size).sum(),
        total_files: local.len(),
    };
    let mut summary = RunSummary::now(RunAction::Plan, RunStatus::Completed);
    summary.plan_counts = Some(counts);
    emit(observer, RunEvent::Complete(summary));
    Ok(result)
}

struct ScanOutcome {
    skipped: usize,
    skipped_entries: Vec<SkippedArchiveEntry>,
    source_root: PathBuf,
}

fn scan_and_hash(
    options: &PlanOptions,
    remote: &[RemoteEntrySnapshot],
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<(Vec<MediaItem>, ScanOutcome)> {
    let coalescer = ProgressCoalescer::new(observer);
    let on_progress = |progress| coalescer.report(progress);
    let mut scan = ScanArchive::new(&options.source_root)
        .cancel_on(cancel)
        .on_progress(&on_progress);
    if let Some(concurrency) = options.directory_concurrency {
        scan = scan.directory_concurrency(concurrency);
    }
    if let Some(concurrency) = options.file_concurrency {
        scan = scan.file_concurrency(concurrency);
    }
    let scanned = scan.run()?;
    let mut local = scanned.items;

    if options.hash_mode != HashMode::None {
        let loaded = load_hash_cache(&scanned.source_root, &options.hash_cache_root);
        if let Some(warning) = loaded.warning {
            status(observer, format!("Warning: {warning}"));
        }
        let mut cache = loaded.cache;
        let (hydrated, hits) = cache.hydrate(local, &scanned.fingerprints);
        local = hydrated;
        let hash_paths = select_planning_hash_paths(options.hash_mode, &local, remote);
        status(
            observer,
            format!(
                "Hash cache: {} hit(s); {} file(s) require hashing.",
                format_count(hits),
                format_count(hash_paths.len())
            ),
        );
        if !hash_paths.is_empty() {
            let paths: HashSet<String> = hash_paths.into_iter().collect();
            let mut hashing = HashArchiveItems::new(&scanned.source_root, local)
                .fingerprints(&scanned.fingerprints)
                .paths(&paths)
                .cancel_on(cancel)
                .on_progress(&on_progress);
            if let Some(concurrency) = options.file_concurrency {
                hashing = hashing.file_concurrency(concurrency);
            }
            local = hashing.run()?;
        }
        cache.update_from_items(&local, &scanned.fingerprints);
        cache.retain(&local.iter().map(|item| item.path.clone()).collect());
        if let Err(error) = cache.save() {
            status(
                observer,
                format!("Warning: hash cache could not be saved: {error}"),
            );
        }
    }
    coalescer.flush();

    Ok((
        local,
        ScanOutcome {
            skipped: scanned.skipped,
            skipped_entries: scanned.skipped_entries,
            source_root: scanned.source_root,
        },
    ))
}

/// `selectPlanningHashPaths`: the files a plan hashes, in the local order. `None` hashes nothing.
pub fn select_planning_hash_paths(
    mode: HashMode,
    local: &[MediaItem],
    remote: &[RemoteEntrySnapshot],
) -> Vec<String> {
    match mode {
        HashMode::None => Vec::new(),
        HashMode::All => local
            .iter()
            .filter(|item| item.sha256.is_none())
            .map(|item| item.path.clone())
            .collect(),
        HashMode::RemoteAware => {
            let local_paths: Vec<&str> = local.iter().map(|item| item.path.as_str()).collect();
            let remote_paths: Vec<&str> = remote.iter().map(|entry| entry.path.as_str()).collect();
            let pairs: HashMap<&str, &str> = pair_sync_paths(&local_paths, &remote_paths)
                .into_iter()
                .collect();
            let remote_by_path: HashMap<&str, &RemoteEntrySnapshot> = remote
                .iter()
                .map(|entry| (entry.path.as_str(), entry))
                .collect();
            let mut seen = HashSet::new();
            local
                .iter()
                .filter(|item| {
                    item.sha256.is_none()
                        && pairs
                            .get(item.path.as_str())
                            .and_then(|paired| remote_by_path.get(paired))
                            .is_some_and(|entry| entry.sha256.is_some() && entry.size == item.size)
                })
                .filter(|item| seen.insert(item.path.clone()))
                .map(|item| item.path.clone())
                .collect()
        }
    }
}

/// `selectChangedItems`: everything but the keeps.
pub fn select_changed_items(items: &[SyncPlanItem]) -> Vec<&SyncPlanItem> {
    items
        .iter()
        .filter(|item| item.action != SyncPlanAction::Keep)
        .collect()
}

/// `selectUploadUpdateItems`: the uploads and updates, the first `max_changes` of them when
/// capped, with how many the cap left out.
pub fn select_upload_update_items<'a>(
    changed: &[&'a SyncPlanItem],
    max_changes: Option<usize>,
) -> (Vec<&'a SyncPlanItem>, usize) {
    cap(
        changed
            .iter()
            .copied()
            .filter(|item| matches!(item.action, SyncPlanAction::Upload | SyncPlanAction::Update))
            .collect(),
        max_changes,
    )
}

/// `selectDeleteItems`: the deletes, capped as uploads are.
pub fn select_delete_items<'a>(
    changed: &[&'a SyncPlanItem],
    max_changes: Option<usize>,
) -> (Vec<&'a SyncPlanItem>, usize) {
    cap(
        changed
            .iter()
            .copied()
            .filter(|item| item.action == SyncPlanAction::Delete)
            .collect(),
        max_changes,
    )
}

fn cap(mut items: Vec<&SyncPlanItem>, max_changes: Option<usize>) -> (Vec<&SyncPlanItem>, usize) {
    // `!maxChanges` lets 0 through uncapped, as the TypeScript does.
    match max_changes {
        Some(max) if max > 0 && items.len() > max => {
            let omitted = items.len() - max;
            items.truncate(max);
            (items, omitted)
        }
        _ => (items, 0),
    }
}

/// `createScanProgressCoalescer`: at most one report every 200 ms for the same file, and every
/// report at once when the file or the stage changes. The scan reports from its pool's threads.
struct ProgressCoalescer<'a> {
    observer: Option<&'a Observer>,
    state: Mutex<CoalescerState>,
}

struct CoalescerState {
    pending: Option<ScanArchiveProgress>,
    last_key: Option<String>,
    last_emit: Option<Instant>,
}

const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);

impl<'a> ProgressCoalescer<'a> {
    fn new(observer: Option<&'a Observer>) -> Self {
        Self {
            observer,
            state: Mutex::new(CoalescerState {
                pending: None,
                last_key: None,
                last_emit: None,
            }),
        }
    }

    fn key(progress: &ScanArchiveProgress) -> String {
        match progress {
            ScanArchiveProgress::Hashing { path, .. } => format!("hashing:{path}"),
            ScanArchiveProgress::Scanning { path, .. } => {
                format!("scanning:{}", path.as_deref().unwrap_or(""))
            }
        }
    }

    fn report(&self, progress: ScanArchiveProgress) {
        let Some(observer) = self.observer else {
            return;
        };
        let key = Self::key(&progress);
        let emit_now = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let due = state.last_key.as_deref() != Some(key.as_str())
                || state
                    .last_emit
                    .is_none_or(|at| at.elapsed() >= PROGRESS_THROTTLE);
            if due {
                state.pending = None;
                state.last_key = Some(key);
                state.last_emit = Some(Instant::now());
                Some(progress)
            } else {
                state.pending = Some(progress);
                None
            }
        };
        if let Some(progress) = emit_now {
            observer(RunEvent::ScanProgress(progress));
        }
    }

    fn flush(&self) {
        let pending = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pending
            .take();
        if let (Some(observer), Some(progress)) = (self.observer, pending) {
            observer(RunEvent::ScanProgress(progress));
        }
    }
}

/// Whether an error is a cancel, however deep in its chain.
pub(crate) fn is_cancelled(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<Cancelled>())
}
