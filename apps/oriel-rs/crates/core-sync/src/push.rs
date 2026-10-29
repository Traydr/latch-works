//! Pushing, from `push-changes.ts` and `remote-api.ts`: a plan's uploads and updates sent to Pane
//! View through a bounded queue, inside one sync run that is always finalized.
//!
//! Each item is checked against the plan (a file that changed since is refused), hashed unless
//! the cache knows it, registered for a signed upload URL, streamed with its bytes hashed again
//! on the way out, checked once more, and recorded in the library. An item's failure is counted
//! and the queue goes on; a cancel stops new items, aborts those under way, and finalizes the
//! run as cancelled.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use futures::StreamExt as _;
use oriel_core_domain::{MediaItem, format_bytes, get_base_name, get_extension};
use oriel_core_index::{
    ArchiveFileFingerprint, SyncPlanAction, SyncPlanItem, fingerprints_match, hash_file_contents,
    modified_ms,
};
use oriel_runtime::{CancelToken, Cancelled};

use crate::api::{ApiTarget, PROGRESS_INTERVAL, PaneViewClient, types, until_cancelled};
use crate::events::{
    Observer, PlanCounts, RunAction, RunEvent, RunStatus, RunSummary, emit, status,
};
use crate::format::format_push_error;
use crate::hash_cache::{HashCache, load_hash_cache};
use crate::plan::{
    HashMode, LockstepPlan, PlanOptions, is_cancelled, plan_sync, select_changed_items,
    select_upload_update_items,
};
use crate::rules::{
    content_type_for_extension, resolve_local_file_path, resolve_upload_concurrency,
};

/// `PushChangesOptions`.
#[derive(Clone, Debug)]
pub struct PushOptions {
    pub api: ApiTarget,
    pub source_root: PathBuf,
    pub hash_cache_root: PathBuf,
    /// How a push without `plan` plans first; remote-aware when unset, as Sync and the CLI push.
    pub hash_mode: Option<HashMode>,
    /// Pushes at most this many of the plan's uploads and updates, in plan order.
    pub max_changes: Option<usize>,
    /// The plan to push; without one the push plans first.
    pub plan: Option<LockstepPlan>,
    /// The upload queue's width, 1 to 8; 3 when unset.
    pub upload_concurrency: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct PushResult {
    pub failed: usize,
    pub plan: LockstepPlan,
    pub pushed: usize,
}

/// Every finalization attempt failed, so Pane View still shows the run as running and blocks
/// library maintenance until it is cancelled on its management page (`UnfinalizedSyncRunError`).
#[derive(Debug)]
pub struct UnfinalizedSyncRun {
    pub action: RunAction,
    pub intended_status: RunStatus,
    pub message: String,
    pub sync_run_id: String,
}

impl std::fmt::Display for UnfinalizedSyncRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UnfinalizedSyncRun {}

/// How a run ended early, for its finalization and its error.
pub(crate) enum Interruption {
    Cancelled,
    Failed(String),
}

/// `failUnfinalizedRun`: reports the run as failed, naming it so it can be cancelled in Pane
/// View, and returns the error to end with.
#[allow(clippy::too_many_arguments)]
pub(crate) fn fail_unfinalized_run(
    action: RunAction,
    done: &str,
    failed: usize,
    finalize_error: &anyhow::Error,
    interruption: Option<&Interruption>,
    observer: Option<&Observer>,
    plan_counts: PlanCounts,
    pushed: usize,
    skipped: Option<usize>,
    sync_run_id: &str,
) -> anyhow::Error {
    let outcome = match interruption {
        Some(Interruption::Cancelled) => format!("Run cancelled after {done}"),
        Some(Interruption::Failed(message)) => format!("{message} Stopped after {done}"),
        None => done.to_owned(),
    };
    let message = format!(
        "{outcome}, but sync run {sync_run_id} could not be finalized: {}. Pane View shows it as \
         running until it is cancelled on the management page.",
        format_push_error(finalize_error)
    );
    let mut summary = RunSummary::now(action, RunStatus::Failed);
    summary.failed = failed;
    summary.message = Some(message.clone());
    summary.plan_counts = Some(plan_counts);
    summary.pushed = pushed;
    summary.skipped = skipped;
    emit(observer, RunEvent::Complete(summary));
    let intended_status = match interruption {
        Some(Interruption::Cancelled) => RunStatus::Cancelled,
        Some(Interruption::Failed(_)) => RunStatus::Failed,
        None if failed > 0 => RunStatus::Failed,
        None => RunStatus::Completed,
    };
    UnfinalizedSyncRun {
        action,
        intended_status,
        message,
        sync_run_id: sync_run_id.to_owned(),
    }
    .into()
}

pub(crate) fn api_counts(counts: PlanCounts) -> types::LockstepPlanCounts {
    types::LockstepPlanCounts {
        delete: counts.delete as f64,
        keep: counts.keep as f64,
        update: counts.update as f64,
        upload: counts.upload as f64,
    }
}

/// `pushChanges`. Run it on the tokio thread.
pub async fn push_changes(
    options: PushOptions,
    client: &PaneViewClient,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<PushResult> {
    cancel.check()?;
    let upload_concurrency = resolve_upload_concurrency(options.upload_concurrency)?;

    let plan = match options.plan {
        Some(plan) => plan,
        None => {
            plan_sync(
                PlanOptions {
                    source_root: options.source_root.clone(),
                    hash_cache_root: options.hash_cache_root.clone(),
                    hash_mode: options.hash_mode.unwrap_or(HashMode::RemoteAware),
                    directory_concurrency: None,
                    file_concurrency: None,
                },
                Some(client),
                observer,
                cancel,
            )
            .await?
        }
    };
    cancel.check()?;

    let changed = select_changed_items(&plan.items);
    let (to_push, omitted) = select_upload_update_items(&changed, options.max_changes);
    let to_push: Vec<SyncPlanItem> = to_push.into_iter().cloned().collect();
    let planned = changed.len();

    if to_push.is_empty() {
        let mut summary = RunSummary::now(RunAction::Push, RunStatus::Completed);
        summary.message = Some("Nothing to push.".to_owned());
        summary.plan_counts = Some(plan.counts);
        emit(observer, RunEvent::Complete(summary));
        return Ok(PushResult {
            failed: 0,
            plan,
            pushed: 0,
        });
    }

    let total = to_push.len();
    if omitted > 0 {
        status(
            observer,
            format!("Pushing {total} of {planned} changes (capped by max-changes)."),
        );
    } else {
        status(
            observer,
            format!("Pushing {total} upload/update change(s)."),
        );
    }
    emit(
        observer,
        RunEvent::ItemsQueued {
            action: "push".to_owned(),
            total,
            total_bytes: to_push
                .iter()
                .filter_map(|item| item.local.as_ref().map(|local| local.size))
                .sum(),
        },
    );

    let source_root = plan.source_root.clone();
    let cache_root = options.hash_cache_root.clone();
    let loaded =
        tokio::task::spawn_blocking(move || load_hash_cache(&source_root, &cache_root)).await?;
    if let Some(warning) = &loaded.warning {
        status(observer, format!("Warning: {warning}"));
    }
    let cache = Arc::new(Mutex::new(loaded.cache));

    status(observer, "Creating sync run...");
    // A cancel does not abort creation (see `create_sync_run`); it skips every item and
    // finalizes the run as cancelled.
    let sync_run_id = client
        .create_sync_run(
            &types::CreateSyncRunRequest {
                counts: api_counts(plan.counts),
                source_root: plan.source_root.to_string_lossy().into_owned(),
            },
            Some(cancel),
        )
        .await?;

    let tally = Mutex::new((0usize, 0usize));
    let context = ItemContext {
        cache: &cache,
        client,
        observer,
        cancel,
        source_root: &plan.source_root,
        sync_run_id: &sync_run_id,
        total,
    };
    // The items' futures are made up front (they do nothing until polled), so the queue holds no
    // closure over borrowed items, which would keep the run from being `Send`.
    let work: Vec<_> = to_push
        .iter()
        .enumerate()
        .map(|(index, item)| push_item(&context, &tally, index + 1, item))
        .collect();
    futures::stream::iter(work)
        .buffer_unordered(upload_concurrency)
        .for_each(|()| async {})
        .await;
    let (pushed, failed) = *tally.lock().unwrap_or_else(PoisonError::into_inner);

    // Decided once, after the queue: the server and the caller must agree on how the run ended.
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
            pushed: pushed as f64,
        },
        error: if cancelled {
            Some("Run cancelled by user".to_owned())
        } else if failed > 0 {
            Some(format!("{failed} item(s) failed during push"))
        } else {
            None
        },
        status: if cancelled {
            types::CompleteSyncRunRequestStatus::Cancelled
        } else if failed > 0 {
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

    let to_save = cache.lock().unwrap_or_else(PoisonError::into_inner).clone();
    if let Err(error) = tokio::task::spawn_blocking(move || to_save.save()).await? {
        status(
            observer,
            format!("Warning: hash cache could not be saved: {error}"),
        );
    }

    // An unfinalized run outranks a cancel: it is the one the user must act on.
    if let Some(finalize_error) = finalize_error {
        status(
            observer,
            format!(
                "Warning: failed to finalize sync run: {}",
                format_push_error(&finalize_error)
            ),
        );
        return Err(fail_unfinalized_run(
            RunAction::Push,
            &format!("{pushed} item(s) pushed"),
            failed,
            &finalize_error,
            cancelled.then_some(&Interruption::Cancelled),
            observer,
            plan.counts,
            pushed,
            None,
            &sync_run_id,
        ));
    }

    if cancelled {
        let mut summary = RunSummary::now(RunAction::Push, RunStatus::Cancelled);
        summary.failed = failed;
        summary.plan_counts = Some(plan.counts);
        summary.pushed = pushed;
        emit(observer, RunEvent::Complete(summary));
        return Err(Cancelled.into());
    }

    let mut summary = RunSummary::now(
        RunAction::Push,
        if failed > 0 {
            RunStatus::Failed
        } else {
            RunStatus::Completed
        },
    );
    summary.failed = failed;
    summary.plan_counts = Some(plan.counts);
    summary.pushed = pushed;
    emit(observer, RunEvent::Complete(summary));
    Ok(PushResult {
        failed,
        plan,
        pushed,
    })
}

struct ItemContext<'a> {
    cache: &'a Arc<Mutex<HashCache>>,
    client: &'a PaneViewClient,
    observer: Option<&'a Observer>,
    cancel: &'a CancelToken,
    source_root: &'a Path,
    sync_run_id: &'a str,
    total: usize,
}

/// One queue slot: an item from start to success or failure. A cancel before it starts skips
/// it; one while it runs aborts it, uncounted.
async fn push_item(
    context: &ItemContext<'_>,
    tally: &Mutex<(usize, usize)>,
    current: usize,
    item: &SyncPlanItem,
) {
    let Some(local) = &item.local else {
        return;
    };
    if context.cancel.is_cancelled() {
        return;
    }
    let observer = context.observer;
    let action = action_name(item.action);
    let bytes = Some(local.size);
    emit(
        observer,
        RunEvent::ItemStart {
            action: action.to_owned(),
            bytes,
            current,
            path: item.path.clone(),
            total: context.total,
        },
    );

    let outcome = async {
        let local = resolve_push_item_hash(context, current, local).await?;
        // Keep the existing library row when only case or the jpeg/jpg spelling differs.
        let logical_path = match (&item.action, &item.remote) {
            (SyncPlanAction::Update, Some(remote)) => remote.path.clone(),
            _ => local.path.clone(),
        };
        push_media_item(context, current, &item.path, &local, &logical_path).await
    }
    .await;

    match outcome {
        Ok(()) => {
            tally.lock().unwrap_or_else(PoisonError::into_inner).0 += 1;
            emit(
                observer,
                RunEvent::ItemSuccess {
                    action: action.to_owned(),
                    bytes,
                    current,
                    path: item.path.clone(),
                    total: context.total,
                },
            );
        }
        Err(_) if context.cancel.is_cancelled() => {}
        Err(error) if is_cancelled(&error) => {}
        Err(error) => {
            tally.lock().unwrap_or_else(PoisonError::into_inner).1 += 1;
            emit(
                observer,
                RunEvent::ItemFailure {
                    action: action.to_owned(),
                    bytes,
                    current,
                    error: format_push_error(&error),
                    path: item.path.clone(),
                    total: context.total,
                },
            );
        }
    }
}

pub(crate) fn action_name(action: SyncPlanAction) -> &'static str {
    match action {
        SyncPlanAction::Upload => "upload",
        SyncPlanAction::Update => "update",
        SyncPlanAction::Keep => "keep",
        SyncPlanAction::Delete => "delete",
    }
}

/// The fingerprint `fs.stat` gives now, the change time as it is.
async fn stat_fingerprint(path: &Path) -> anyhow::Result<(ArchiveFileFingerprint, f64)> {
    let metadata = tokio::fs::metadata(path).await?;
    let mtime = modified_ms(&metadata);
    Ok((
        ArchiveFileFingerprint {
            ctime_ms: change_time_ms(&metadata),
            mtime_ms: mtime.trunc(),
            size: metadata.len(),
        },
        mtime,
    ))
}

#[cfg(unix)]
fn change_time_ms(metadata: &std::fs::Metadata) -> Option<f64> {
    use std::os::unix::fs::MetadataExt as _;
    Some(metadata.ctime() as f64 * 1e3 + metadata.ctime_nsec() as f64 / 1e6)
}

#[cfg(not(unix))]
fn change_time_ms(_: &std::fs::Metadata) -> Option<f64> {
    None
}

/// `resolvePushItemHash`: the item with its SHA-256, from the cache when the file is unchanged,
/// else hashed now. A file that differs from the plan, or changes while hashed, is refused.
async fn resolve_push_item_hash(
    context: &ItemContext<'_>,
    current: usize,
    item: &MediaItem,
) -> anyhow::Result<MediaItem> {
    let file_path = resolve_local_file_path(context.source_root, &item.path)?;
    let (fingerprint, _) = stat_fingerprint(&file_path).await?;
    let changed = || {
        anyhow::anyhow!(
            "Local file changed after planning; rerun sync: {}",
            item.path
        )
    };
    if fingerprint.size != item.size || fingerprint.mtime_ms != item.mtime_ms.trunc() {
        return Err(changed());
    }

    let cached = context
        .cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&item.path, &fingerprint)
        .map(str::to_owned);
    let sha256 = match cached {
        Some(sha256) => sha256,
        None => {
            let total = context.total;
            status(
                context.observer,
                format!("[{current}/{total}] hashing {}", item.path),
            );
            let sha256 = hash_in_background(context, current, &item.path, &file_path).await?;
            let (after, _) = stat_fingerprint(&file_path).await?;
            if !fingerprints_match(&fingerprint, &after) {
                return Err(changed());
            }
            context
                .cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .set(&item.path, &fingerprint, &sha256)?;
            sha256
        }
    };
    let mut item = item.clone();
    item.id = sha256.clone();
    item.sha256 = Some(sha256);
    Ok(item)
}

/// `hashLocalFile`: the file's SHA-256 on a blocking thread, reporting its bytes every 100 ms.
async fn hash_in_background(
    context: &ItemContext<'_>,
    current: usize,
    archive_path: &str,
    file_path: &Path,
) -> anyhow::Result<String> {
    let observer = context.observer.cloned();
    let cancel = context.cancel.clone();
    let total = context.total;
    let archive_path = archive_path.to_owned();
    let file_path = file_path.to_owned();
    let hashing = tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&file_path)?.len();
        let last = Mutex::new(std::time::Instant::now());
        let report = |bytes: u64| {
            let mut last = last.lock().unwrap_or_else(PoisonError::into_inner);
            if last.elapsed() >= PROGRESS_INTERVAL || bytes == size {
                *last = std::time::Instant::now();
                status(
                    observer.as_ref(),
                    format!(
                        "[{current}/{total}] hashing {archive_path} ({} / {})",
                        format_bytes(bytes as f64),
                        format_bytes(size as f64)
                    ),
                );
            }
        };
        hash_file_contents(&file_path, None, Some(&cancel), &report)
    });
    let sha256 = until_cancelled(Some(context.cancel), hashing).await???;
    Ok(sha256)
}

/// `pushMediaItem`: registers, uploads and records one file under `logical_path`.
async fn push_media_item(
    context: &ItemContext<'_>,
    current: usize,
    plan_path: &str,
    item: &MediaItem,
    logical_path: &str,
) -> anyhow::Result<()> {
    let observer = context.observer;
    let total = context.total;
    let stage = |stage: &str, detail: &str| {
        let detail = if detail.is_empty() {
            String::new()
        } else {
            format!(" ({detail})")
        };
        status(
            observer,
            format!("[{current}/{total}] {stage} {plan_path}{detail}"),
        );
    };
    let file_path = resolve_local_file_path(context.source_root, &item.path)?;
    let registration_name = get_base_name(logical_path);
    let registration_extension = get_extension(&registration_name);
    let content_type = content_type_for_extension(&registration_extension);
    let (before, before_mtime) = stat_fingerprint(&file_path).await?;
    let sha256 = item
        .sha256
        .clone()
        .ok_or_else(|| anyhow::anyhow!("{} has no hash", item.path))?;

    stage("registering", "requesting upload URL");
    let target = context
        .client
        .upload_url(
            &types::UploadUrlRequest {
                content_type: content_type.to_owned(),
                filename: registration_name.clone(),
                sha256: sha256.clone(),
                size: before.size as f64,
            },
            Some(context.cancel),
        )
        .await?;

    match &target.upload_url {
        Some(upload_url) => {
            let report = |sent: u64, of: u64| {
                stage(
                    "uploading",
                    &format!(
                        "{} / {}",
                        format_bytes(sent as f64),
                        format_bytes(of as f64)
                    ),
                );
            };
            context
                .client
                .upload_file(
                    upload_url,
                    &target.headers,
                    &file_path,
                    content_type,
                    &sha256,
                    before.size,
                    &report,
                    Some(context.cancel),
                )
                .await?;
        }
        None => stage("uploading", "skipped (storage not configured)"),
    }

    let (after, after_mtime) = stat_fingerprint(&file_path).await?;
    if after.size != before.size || after_mtime != before_mtime {
        anyhow::bail!("File changed during sync; retry this item.");
    }

    stage("registering", "recording ingest");
    context
        .client
        .complete_object(
            &types::CompleteObjectRequest {
                content_type: content_type.to_owned(),
                extension: registration_extension,
                filename: registration_name,
                logical_path: logical_path.to_owned(),
                media_type: media_type(item),
                mtime_ms: item.mtime_ms,
                object_key: target.object_key.clone(),
                sha256,
                size: before.size as f64,
                sync_run_id: context.sync_run_id.to_owned(),
            },
            Some(context.cancel),
        )
        .await
}

fn media_type(item: &MediaItem) -> types::CompleteObjectRequestMediaType {
    use oriel_core_domain::MediaType;
    match item.media_type {
        MediaType::Image => types::CompleteObjectRequestMediaType::Image,
        MediaType::Gif => types::CompleteObjectRequestMediaType::Gif,
        MediaType::Video => types::CompleteObjectRequestMediaType::Video,
        MediaType::Pdf => types::CompleteObjectRequestMediaType::Pdf,
        MediaType::Unknown => types::CompleteObjectRequestMediaType::Unknown,
    }
}
