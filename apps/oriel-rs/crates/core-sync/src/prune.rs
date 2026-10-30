//! Pruning, from `prune-deleted.ts` and `directory-alias-index.ts`: the deletes of the plan the
//! user reviewed, applied once, each skipped when its file is back in the source folder.
//!
//! Prune never plans again. A delete is safe only while nothing is at its path and no new file
//! sits under a spelling planning treats as the same (case, Unicode, jpeg and jpg), and only
//! while the source folder is the one prune started with: an unplugged drive would make every
//! file look gone, so a missing or replaced folder stops the whole prune.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use oriel_core_domain::{
    normalize_path_for_compare, normalize_path_for_compare_keeping_extensions,
};
use oriel_core_index::SyncPlanAction;
use oriel_runtime::{CancelToken, Cancelled};

use crate::api::{ApiTarget, PaneViewClient, types};
use crate::events::{Observer, RunAction, RunEvent, RunStatus, RunSummary, emit, status};
use crate::format::format_push_error;
use crate::plan::{LockstepPlan, is_cancelled, select_changed_items, select_delete_items};
use crate::push::{Interruption, api_counts, fail_unfinalized_run};
use crate::rules::resolve_local_file_path;

/// Why a planned delete was left alone; shown beside the path.
const BACK_IN_SOURCE_REASON: &str = "the file is back in the source folder";

/// `PruneDeletedOptions`.
#[derive(Clone, Debug)]
pub struct PruneOptions {
    pub api: ApiTarget,
    /// Applies at most this many of the plan's deletes, in plan order.
    pub max_changes: Option<usize>,
    /// The plan the user reviewed; prune applies its deletes and nothing else.
    pub plan: LockstepPlan,
}

#[derive(Clone, Debug)]
pub struct PruneResult {
    pub failed: usize,
    pub plan: LockstepPlan,
    pub pruned: usize,
    pub skipped: usize,
}

/// Which folder the source is, so a moved or remounted one is noticed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RootIdentity {
    device: u64,
    inode: u64,
}

fn source_root_unavailable(source_root: &Path) -> anyhow::Error {
    anyhow::anyhow!(
        "Source folder is not available: {}. Prune needs it to confirm each file is still gone.",
        source_root.display()
    )
    .context(SourceRootUnavailable)
}

/// Marks the error that stops the whole prune.
#[derive(Debug)]
struct SourceRootUnavailable;

impl std::fmt::Display for SourceRootUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("source folder unavailable")
    }
}

fn root_identity(source_root: &Path) -> anyhow::Result<RootIdentity> {
    match fs::metadata(source_root) {
        Ok(metadata) if metadata.is_dir() => Ok(identity_of(&metadata)),
        _ => Err(source_root_unavailable(source_root)),
    }
}

#[cfg(unix)]
fn identity_of(metadata: &fs::Metadata) -> RootIdentity {
    use std::os::unix::fs::MetadataExt as _;
    RootIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(not(unix))]
fn identity_of(_: &fs::Metadata) -> RootIdentity {
    RootIdentity {
        device: 0,
        inode: 0,
    }
}

/// The source folder's own message for the unavailable root, without the marker context.
fn root_error_message(error: &anyhow::Error) -> String {
    error
        .chain()
        .nth(1)
        .map_or_else(|| error.to_string(), ToString::to_string)
}

fn is_root_unavailable(error: &anyhow::Error) -> bool {
    error.downcast_ref::<SourceRootUnavailable>().is_some()
}

/// `pruneDeleted`. Run it on the tokio thread.
pub async fn prune_deleted(
    options: PruneOptions,
    client: &PaneViewClient,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<PruneResult> {
    cancel.check()?;
    let plan = options.plan;
    let changed = select_changed_items(&plan.items);
    let planned = changed.len();
    let planned_local_paths: Arc<HashSet<String>> = Arc::new(
        plan.items
            .iter()
            .filter(|item| item.action != SyncPlanAction::Delete)
            .map(|item| item.path.clone())
            .collect(),
    );
    let (to_prune, omitted) = select_delete_items(&changed, options.max_changes);
    let to_prune: Vec<String> = to_prune.iter().map(|item| item.path.clone()).collect();

    if to_prune.is_empty() {
        let mut summary = RunSummary::now(RunAction::Prune, RunStatus::Completed);
        summary.message = Some("Nothing to prune.".to_owned());
        summary.plan_counts = Some(plan.counts);
        emit(observer, RunEvent::Complete(summary));
        return Ok(PruneResult {
            failed: 0,
            plan,
            pruned: 0,
            skipped: 0,
        });
    }

    let source_root = plan.source_root.clone();
    let identity = {
        let root = source_root.clone();
        tokio::task::spawn_blocking(move || root_identity(&root))
            .await?
            .map_err(|error| anyhow::anyhow!(root_error_message(&error)))?
    };
    cancel.check()?;

    let total = to_prune.len();
    if omitted > 0 {
        status(
            observer,
            format!(
                "Pruning {total} of {} delete(s) (capped by max-changes).",
                plan.counts.delete
            ),
        );
    } else {
        status(observer, format!("Applying {total} remote delete(s)."));
    }
    emit(
        observer,
        RunEvent::ItemsQueued {
            action: "delete".to_owned(),
            total,
            total_bytes: 0,
        },
    );
    status(observer, "Creating sync run...");
    let sync_run_id = client
        .create_sync_run(
            &types::CreateSyncRunRequest {
                counts: api_counts(plan.counts),
                source_root: plan.source_root.to_string_lossy().into_owned(),
            },
            Some(cancel),
        )
        .await?;

    let alias_index = Arc::new(Mutex::new(DirectoryAliasIndex::new(source_root.clone())));
    let (mut pruned, mut skipped, mut failed) = (0usize, 0usize, 0usize);
    let mut run_error: Option<anyhow::Error> = None;

    for (index, path) in to_prune.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let current = index + 1;
        emit(
            observer,
            RunEvent::ItemStart {
                action: "delete".to_owned(),
                bytes: None,
                current,
                path: path.clone(),
                total,
            },
        );

        let outcome: anyhow::Result<bool> = async {
            // Is the file still gone, and is the source folder still the one prune started
            // with: both on one blocking thread, in that order.
            let absent = {
                let (root, path, planned, index) = (
                    source_root.clone(),
                    path.clone(),
                    planned_local_paths.clone(),
                    alias_index.clone(),
                );
                tokio::task::spawn_blocking(move || {
                    let mut index = index.lock().unwrap_or_else(PoisonError::into_inner);
                    if !is_absent_locally(&root, &path, &planned, &mut index)? {
                        return Ok(false);
                    }
                    if root_identity(&root)? != identity {
                        return Err(source_root_unavailable(&root));
                    }
                    Ok(true)
                })
                .await??
            };
            if !absent {
                return Ok(false);
            }
            status(observer, format!("[{current}/{total}] deleting {path}"));
            client
                .delete_object(path, &sync_run_id, Some(cancel))
                .await?;
            Ok(true)
        }
        .await;

        match outcome {
            Ok(true) => {
                pruned += 1;
                emit(
                    observer,
                    RunEvent::ItemSuccess {
                        action: "delete".to_owned(),
                        bytes: None,
                        current,
                        path: path.clone(),
                        total,
                    },
                );
            }
            Ok(false) => {
                skipped += 1;
                emit(
                    observer,
                    RunEvent::ItemSkipped {
                        action: "delete".to_owned(),
                        current,
                        path: path.clone(),
                        reason: BACK_IN_SOURCE_REASON.to_owned(),
                        total,
                    },
                );
            }
            Err(_) if cancel.is_cancelled() => break,
            Err(error) if is_cancelled(&error) => break,
            Err(error) if is_root_unavailable(&error) => {
                run_error = Some(anyhow::anyhow!(root_error_message(&error)));
                break;
            }
            Err(error) => {
                failed += 1;
                emit(
                    observer,
                    RunEvent::ItemFailure {
                        action: "delete".to_owned(),
                        bytes: None,
                        current,
                        error: format_push_error(&error),
                        path: path.clone(),
                        total,
                    },
                );
            }
        }
    }

    let cancelled = cancel.is_cancelled();
    let body = types::CompleteSyncRunRequest {
        counts: types::SyncRunOutcomeCounts {
            delete: plan.counts.delete as f64,
            keep: plan.counts.keep as f64,
            update: plan.counts.update as f64,
            upload: plan.counts.upload as f64,
            capped: total as f64,
            failed: failed as f64,
            planned: planned as f64,
            pushed: pruned as f64,
        },
        error: if cancelled {
            Some("Run cancelled by user".to_owned())
        } else if let Some(error) = &run_error {
            Some(error.to_string())
        } else if failed > 0 {
            Some(format!("{failed} delete(s) failed during prune"))
        } else {
            None
        },
        status: if cancelled {
            types::CompleteSyncRunRequestStatus::Cancelled
        } else if run_error.is_some() || failed > 0 {
            types::CompleteSyncRunRequestStatus::Failed
        } else {
            types::CompleteSyncRunRequestStatus::Completed
        },
    };
    let finalize_error = client
        .finalize_sync_run(&sync_run_id, &body, |error| {
            status(
                observer,
                format!(
                    "Warning: failed to finalize sync run, retrying: {}",
                    format_push_error(error)
                ),
            );
        })
        .await;

    if let Some(finalize_error) = finalize_error {
        status(
            observer,
            format!(
                "Warning: failed to finalize sync run: {}",
                format_push_error(&finalize_error)
            ),
        );
        let interruption = if cancelled {
            Some(Interruption::Cancelled)
        } else {
            run_error
                .as_ref()
                .map(|error| Interruption::Failed(error.to_string()))
        };
        return Err(fail_unfinalized_run(
            RunAction::Prune,
            &format!("{pruned} delete(s) applied"),
            failed,
            &finalize_error,
            interruption.as_ref(),
            observer,
            plan.counts,
            pruned,
            Some(skipped),
            &sync_run_id,
        ));
    }

    if cancelled {
        let mut summary = RunSummary::now(RunAction::Prune, RunStatus::Cancelled);
        summary.failed = failed;
        summary.plan_counts = Some(plan.counts);
        summary.pushed = pruned;
        summary.skipped = Some(skipped);
        emit(observer, RunEvent::Complete(summary));
        return Err(Cancelled.into());
    }
    if let Some(error) = run_error {
        return Err(error);
    }

    let mut summary = RunSummary::now(
        RunAction::Prune,
        if failed > 0 {
            RunStatus::Failed
        } else {
            RunStatus::Completed
        },
    );
    summary.failed = failed;
    summary.message = (skipped > 0)
        .then(|| format!("{skipped} delete(s) skipped because {BACK_IN_SOURCE_REASON}."));
    summary.plan_counts = Some(plan.counts);
    summary.pushed = pruned;
    summary.skipped = Some(skipped);
    emit(observer, RunEvent::Complete(summary));
    Ok(PruneResult {
        failed,
        plan,
        pruned,
        skipped,
    })
}

/// `isAbsentLocally`: nothing at the path, and no file under a spelling planning treats as the
/// same that the plan does not already account for. Errors other than "missing" fail the item.
fn is_absent_locally(
    source_root: &Path,
    archive_path: &str,
    planned_local_paths: &HashSet<String>,
    index: &mut DirectoryAliasIndex,
) -> anyhow::Result<bool> {
    match fs::symlink_metadata(resolve_local_file_path(source_root, archive_path)?) {
        Ok(_) => return Ok(false),
        Err(error) if is_missing(&error) => {}
        Err(error) => return Err(error.into()),
    }
    let equivalents = index.find_equivalent_paths(archive_path)?;
    Ok(equivalents
        .iter()
        .all(|path| planned_local_paths.contains(path)))
}

/// `MissingPathErrorSchema`: ENOENT or ENOTDIR.
fn is_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(20)
}

/// Coarse file systems store folder times in steps of up to 2 s, so a listing this close to its
/// folder's last change is never reused; 1 s of it allows for clock skew.
const RACY_LISTING_WINDOW_NS: i128 = 3_000_000_000;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum NameKind {
    File,
    Folder,
}

struct DirectoryListing {
    state: FolderState,
    /// Whether the folder last changed long enough before the listing for it to be reused.
    reusable: bool,
    names: Vec<String>,
    by_kind: HashMap<NameKind, HashMap<String, Vec<String>>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FolderState {
    device: u64,
    inode: u64,
    modified_ns: i128,
    changed_ns: i128,
}

/// `DirectoryAliasIndex`: finds the entries under the source folder that planning treats as one
/// path, reusing each folder's listing while the folder is unchanged.
struct DirectoryAliasIndex {
    source_root: PathBuf,
    listings: HashMap<String, DirectoryListing>,
}

impl DirectoryAliasIndex {
    fn new(source_root: PathBuf) -> Self {
        Self {
            source_root,
            listings: HashMap::new(),
        }
    }

    /// Archive paths planning would treat as `archive_path`: folders match across case and
    /// Unicode, the file name also across jpeg and jpg.
    fn find_equivalent_paths(&mut self, archive_path: &str) -> anyhow::Result<Vec<String>> {
        let segments: Vec<&str> = archive_path.split('/').collect();
        let mut candidates = vec![String::new()];
        for (index, segment) in segments.iter().enumerate() {
            let kind = if index == segments.len() - 1 {
                NameKind::File
            } else {
                NameKind::Folder
            };
            let wanted = normalize_name(segment, kind);
            let mut next = Vec::new();
            for parent in &candidates {
                for name in self.names_matching(parent, &wanted, kind)? {
                    next.push(if parent.is_empty() {
                        name
                    } else {
                        format!("{parent}/{name}")
                    });
                }
            }
            candidates = next;
        }
        Ok(candidates)
    }

    fn names_matching(
        &mut self,
        archive_dir: &str,
        wanted: &str,
        kind: NameKind,
    ) -> anyhow::Result<Vec<String>> {
        let Some(listing) = self.read_listing(archive_dir)? else {
            return Ok(Vec::new());
        };
        let names = &listing.names;
        let index = listing.by_kind.entry(kind).or_insert_with(|| {
            let mut index: HashMap<String, Vec<String>> = HashMap::new();
            for name in names {
                index
                    .entry(normalize_name(name, kind))
                    .or_default()
                    .push(name.clone());
            }
            index
        });
        Ok(index.get(wanted).cloned().unwrap_or_default())
    }

    fn read_listing(&mut self, archive_dir: &str) -> anyhow::Result<Option<&mut DirectoryListing>> {
        let directory = if archive_dir.is_empty() {
            self.source_root.clone()
        } else {
            resolve_local_file_path(&self.source_root, archive_dir)?
        };
        // Stat before listing: a change between the two leaves newer times than the stored
        // ones, so the next lookup reads the folder again.
        let listed_at_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as i128 * 1_000_000)
            .unwrap_or(0);
        let current = match fs::metadata(&directory) {
            Ok(metadata) => Some(metadata),
            Err(error) if is_missing(&error) => None,
            Err(error) => return Err(error.into()),
        };
        let current_state = current.as_ref().map(folder_state);
        let reusable = matches!(
            (self.listings.get(archive_dir), current_state),
            (Some(cached), Some(state)) if cached.reusable && cached.state == state
        );
        if reusable {
            return Ok(self.listings.get_mut(archive_dir));
        }
        self.listings.remove(archive_dir);
        let (Some(metadata), Some(state)) = (current, current_state) else {
            return Ok(None);
        };
        if !metadata.is_dir() {
            return Ok(None);
        }
        let names = match fs::read_dir(&directory) {
            Ok(entries) => entries
                .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
                .collect::<io::Result<Vec<_>>>()?,
            Err(error) if is_missing(&error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let last_change = state.modified_ns.max(state.changed_ns);
        let listing = DirectoryListing {
            state,
            reusable: listed_at_ns - last_change > RACY_LISTING_WINDOW_NS,
            names,
            by_kind: HashMap::new(),
        };
        self.listings.insert(archive_dir.to_owned(), listing);
        Ok(self.listings.get_mut(archive_dir))
    }
}

fn normalize_name(name: &str, kind: NameKind) -> String {
    match kind {
        NameKind::File => normalize_path_for_compare(name),
        NameKind::Folder => normalize_path_for_compare_keeping_extensions(name),
    }
}

#[cfg(unix)]
fn folder_state(metadata: &fs::Metadata) -> FolderState {
    use std::os::unix::fs::MetadataExt as _;
    FolderState {
        device: metadata.dev(),
        inode: metadata.ino(),
        modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
            + i128::from(metadata.mtime_nsec()),
        changed_ns: i128::from(metadata.ctime()) * 1_000_000_000
            + i128::from(metadata.ctime_nsec()),
    }
}

#[cfg(not(unix))]
fn folder_state(metadata: &fs::Metadata) -> FolderState {
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos() as i128);
    FolderState {
        device: 0,
        inode: 0,
        modified_ns,
        changed_ns: modified_ns,
    }
}
