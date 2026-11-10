//! Pushing, from `push-changes.ts` and `remote-api.ts`: a plan's uploads and updates sent to Pane
//! View through a bounded queue, inside one sync run ([`SyncRun`]) that is always finalized.
//!
//! Each item is checked against the plan (a file that changed since is refused), hashed unless
//! the cache knows it, registered for a signed upload URL, streamed with its bytes hashed again
//! on the way out, checked once more, and recorded in the library. An item's failure is counted
//! and the queue goes on; a cancel stops new items, aborts those under way, and finalizes the
//! run as cancelled.
//!
//! The queue runs as many items at once as the caller asks, or, when it does not, as many as
//! [`UploadWidth`] finds worth running.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::StreamExt as _;
use futures::stream::FuturesUnordered;
use oriel_core_domain::{MediaItem, MediaType, format, get_base_name, get_extension};
use oriel_runtime::CancelToken;
use oriel_runtime::fs_meta::modified_ms;

use crate::api::{
    ApiTarget, PROGRESS_INTERVAL, PaneViewClient, is_overload, types, until_cancelled,
};
use crate::events::{Observer, RunAction, RunEvent, RunSummary, emit, status};
use crate::format::format_push_error;
use crate::hash_cache::{HashCache, HashCacheEntry, load_hash_cache};
use crate::plan::{LockstepPlan, is_cancelled, planned_changes, planned_uploads};
use crate::rules::{
    content_type_for_extension, resolve_local_file_path, resolve_upload_concurrency,
};
use crate::rust_only::{UploadSample, UploadWidth};
use crate::scan::{ArchiveFileFingerprint, fingerprints_match, hash_file_contents};
use crate::sync_plan::{SyncPlanAction, SyncPlanItem};
use crate::sync_run::{Interruption, RunOutcome, SyncRun};

/// `PushChangesOptions`.
#[derive(Clone, Debug)]
pub struct PushOptions {
    pub api: ApiTarget,
    /// The hash cache's folder, `DataRoot::hash_cache()`.
    pub hash_cache: PathBuf,
    /// Pushes at most this many of the plan's uploads and updates, in plan order.
    pub max_changes: Option<usize>,
    /// The plan the user reviewed; push uploads and updates its items and never plans again.
    pub plan: LockstepPlan,
    /// The upload queue's width, 1 to 8. Unset, [`UploadWidth`] picks it as the push goes.
    pub upload_concurrency: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct PushResult {
    pub plan: LockstepPlan,
    pub summary: RunSummary,
    /// Each width the upload queue ran at, with when it took over, from the first upload.
    pub upload_widths: Vec<(Duration, usize)>,
}

/// `pushChanges`. Run it on the tokio thread.
pub async fn push_changes(
    options: PushOptions,
    client: &PaneViewClient,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<PushResult> {
    cancel.check()?;
    // A width the caller asks for is checked, and kept; none leaves it to the controller.
    let fixed_width = options
        .upload_concurrency
        .map(|width| resolve_upload_concurrency(Some(width)))
        .transpose()?;

    let plan = options.plan;
    let cache = {
        let source_root = plan.source_root.clone();
        let folder = options.hash_cache.clone();
        let loaded =
            tokio::task::spawn_blocking(move || load_hash_cache(&source_root, &folder)).await?;
        if let Some(warning) = &loaded.warning {
            status(observer, format!("Warning: {warning}"));
        }
        loaded.cache
    };
    cancel.check()?;

    let changed = planned_changes(&plan.items);
    let (to_push, omitted) = planned_uploads(&plan.items, options.max_changes);
    let to_push: Vec<SyncPlanItem> = to_push.into_iter().cloned().collect();

    if to_push.is_empty() {
        let summary = RunSummary::nothing_to_do(RunAction::Push, plan.counts);
        emit(observer, RunEvent::Complete(summary.clone()));
        return Ok(PushResult {
            plan,
            summary,
            upload_widths: Vec::new(),
        });
    }

    let total = to_push.len();
    if omitted > 0 {
        status(
            observer,
            format!(
                "Pushing {total} of {} changes (capped by max-changes).",
                changed.len()
            ),
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
            action: RunAction::Push,
            total,
            total_bytes: to_push
                .iter()
                .filter_map(|item| item.local.as_ref().map(|local| local.size))
                .sum(),
        },
    );

    let run = SyncRun::open(RunAction::Push, &plan, client, observer, cancel).await?;
    let cache = Mutex::new(cache);
    let context = ItemContext {
        cache: &cache,
        client,
        observer,
        cancel,
        source_root: &plan.source_root,
        sync_run_id: run.id(),
        total,
        sent: AtomicU64::new(0),
    };
    let (tally, upload_widths) = run_queue(&context, &to_push, fixed_width).await;

    let cache = cache.into_inner().unwrap_or_else(PoisonError::into_inner);
    if let Err(error) = tokio::task::spawn_blocking(move || cache.save()).await? {
        status(
            observer,
            format!("Warning: hash cache could not be saved: {error}"),
        );
    }

    let summary = run
        .finish(RunOutcome {
            applied: tally.pushed,
            capped: total,
            failed: tally.failed,
            skipped: 0,
            interruption: cancel.is_cancelled().then_some(Interruption::Cancelled),
        })
        .await?;
    Ok(PushResult {
        plan,
        summary,
        upload_widths,
    })
}

/// What the queue's items came to.
#[derive(Default)]
struct Tally {
    pushed: usize,
    failed: usize,
}

/// Runs the items, in plan order, at most `width` at once: the fixed width asked for, or the
/// adaptive one, which each finished item informs. Returns what they came to and the widths it
/// ran at.
async fn run_queue(
    context: &ItemContext<'_>,
    items: &[SyncPlanItem],
    fixed_width: Option<usize>,
) -> (Tally, Vec<(Duration, usize)>) {
    let mut tally = Tally::default();
    let mut adaptive = UploadWidth::new();
    let width = |adaptive: &UploadWidth| fixed_width.unwrap_or_else(|| adaptive.width());
    let started = Instant::now();
    let mut counted = 0;
    let mut queued = items.iter().enumerate();
    let mut running = FuturesUnordered::new();
    loop {
        // A cancel starts nothing more; what runs aborts itself.
        while running.len() < width(&adaptive) && !context.cancel.is_cancelled() {
            let Some((index, item)) = queued.next() else {
                break;
            };
            running.push(push_item(context, index + 1, item));
        }
        let Some(outcome) = running.next().await else {
            break;
        };
        match outcome {
            ItemOutcome::Pushed => tally.pushed += 1,
            ItemOutcome::Failed { .. } => tally.failed += 1,
            ItemOutcome::NotRun => {}
        }
        let at = started.elapsed();
        // Once every item has started, the queue cannot fill a wider width, so what it shows
        // says nothing about the link.
        if queued.len() == 0 {
            continue;
        }
        match outcome {
            // Throughput is the bytes the uploads sent, not the sizes of those that finished,
            // so a large file finishing in a window does not read as a faster link.
            ItemOutcome::Pushed => {
                let sent = context.sent.load(Ordering::Relaxed);
                adaptive.record(UploadSample::Completed {
                    bytes: sent - counted,
                    at,
                });
                counted = sent;
            }
            ItemOutcome::Failed { overload: true } => {
                adaptive.record(UploadSample::Overloaded { at });
            }
            ItemOutcome::Failed { overload: false } | ItemOutcome::NotRun => {}
        }
    }
    let widths = match fixed_width {
        Some(width) => vec![(Duration::ZERO, width)],
        None => adaptive.history().to_vec(),
    };
    (tally, widths)
}

/// How one item ended.
#[derive(Clone, Copy)]
enum ItemOutcome {
    Pushed,
    /// `overload` when the failure says the server or the link is overloaded.
    Failed {
        overload: bool,
    },
    /// Skipped or aborted by a cancel, or with nothing to send.
    NotRun,
}

struct ItemContext<'a> {
    /// The run's hash cache, which each item reads and adds the hashes it takes to.
    cache: &'a Mutex<HashCache>,
    client: &'a PaneViewClient,
    observer: Option<&'a Observer>,
    cancel: &'a CancelToken,
    source_root: &'a Path,
    sync_run_id: &'a str,
    total: usize,
    /// The bytes every upload of the run has sent so far, for the upload width.
    sent: AtomicU64,
}

/// One queue slot: an item from start to success or failure. A cancel before it starts skips
/// it; one while it runs aborts it, uncounted.
async fn push_item(context: &ItemContext<'_>, current: usize, item: &SyncPlanItem) -> ItemOutcome {
    let Some(local) = &item.local else {
        return ItemOutcome::NotRun;
    };
    if context.cancel.is_cancelled() {
        return ItemOutcome::NotRun;
    }
    let observer = context.observer;
    let action = item.action;
    let bytes = Some(local.size);
    emit(
        observer,
        RunEvent::ItemStart {
            action,
            bytes,
            current,
            path: item.path.clone(),
            total: context.total,
        },
    );

    let outcome = async {
        let (local, before) = prepare_item(context, current, local).await?;
        // Keep the existing library row when only case or the jpeg/jpg spelling differs.
        let logical_path = match (&item.action, &item.remote) {
            (SyncPlanAction::Update, Some(remote)) => remote.path.clone(),
            _ => local.path.clone(),
        };
        push_media_item(context, current, &item.path, &local, before, &logical_path).await
    }
    .await;

    match outcome {
        Ok(()) => {
            emit(
                observer,
                RunEvent::ItemSuccess {
                    action,
                    bytes,
                    current,
                    path: item.path.clone(),
                    total: context.total,
                },
            );
            ItemOutcome::Pushed
        }
        Err(_) if context.cancel.is_cancelled() => ItemOutcome::NotRun,
        Err(error) if is_cancelled(&error) => ItemOutcome::NotRun,
        Err(error) => {
            emit(
                observer,
                RunEvent::ItemFailure {
                    action,
                    bytes,
                    current,
                    error: format_push_error(&error),
                    path: item.path.clone(),
                    total: context.total,
                },
            );
            ItemOutcome::Failed {
                overload: is_overload(&error),
            }
        }
    }
}

/// The fingerprint `fs.stat` gives now, the change time as it is, with the exact modified time.
type Stat = (ArchiveFileFingerprint, f64);

fn stat_fingerprint(path: &Path) -> std::io::Result<Stat> {
    let metadata = std::fs::metadata(path)?;
    let mtime = modified_ms(&metadata);
    Ok((
        ArchiveFileFingerprint {
            ctime_ms: Some(change_time_ms(path, &metadata)),
            mtime_ms: mtime.trunc(),
            size: metadata.len(),
        },
        mtime,
    ))
}

async fn stat_fingerprint_async(path: &Path) -> anyhow::Result<Stat> {
    let path = path.to_owned();
    Ok(tokio::task::spawn_blocking(move || stat_fingerprint(&path)).await??)
}

/// Node's `ctimeMs`: on Windows NTFS's change time, read from the file itself
/// (`fs_meta::change_time`), as the hash cache and the plan's scan record it there.
fn change_time_ms(path: &Path, metadata: &std::fs::Metadata) -> f64 {
    let (seconds, nanoseconds) = oriel_runtime::fs_meta::change_time(path, metadata);
    seconds as f64 * 1e3 + nanoseconds as f64 / 1e6
}

/// What an item's first look at its file found.
struct Prepared {
    sha256: String,
    /// The fingerprint the file was hashed at, when it was hashed now rather than cached.
    hashed: Option<ArchiveFileFingerprint>,
    /// The file as it was just before it is registered.
    before: Stat,
}

/// `resolvePushItemHash`, then `pushMediaItem`'s first look at the file: the item with its
/// SHA-256, from the cache when the file is unchanged, else hashed now (and added to the cache),
/// and the file as it was just before it is registered. A file that differs from the plan, or
/// changes while hashed, is refused. The file calls are lockstep-core's, in its order, made on
/// one blocking thread rather than a thread each.
async fn prepare_item(
    context: &ItemContext<'_>,
    current: usize,
    item: &MediaItem,
) -> anyhow::Result<(MediaItem, Stat)> {
    let file_path = resolve_local_file_path(context.source_root, &item.path)?;
    let cached = context
        .cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(&item.path)
        .cloned();
    let observer = context.observer.cloned();
    let cancel = context.cancel.clone();
    let total = context.total;
    let planned = item.clone();
    let preparing = tokio::task::spawn_blocking(move || {
        prepare_blocking(
            &file_path,
            &planned,
            cached.as_ref(),
            observer.as_ref(),
            &cancel,
            current,
            total,
        )
    });
    let prepared = until_cancelled(Some(context.cancel), preparing).await???;
    if let Some(fingerprint) = &prepared.hashed {
        context
            .cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .set(&item.path, fingerprint, &prepared.sha256)?;
    }
    let mut item = item.clone();
    item.id = prepared.sha256.clone();
    item.sha256 = Some(prepared.sha256);
    Ok((item, prepared.before))
}

fn prepare_blocking(
    file_path: &Path,
    item: &MediaItem,
    cached: Option<&HashCacheEntry>,
    observer: Option<&Observer>,
    cancel: &CancelToken,
    current: usize,
    total: usize,
) -> anyhow::Result<Prepared> {
    let (fingerprint, _) = stat_fingerprint(file_path)?;
    let changed = || {
        anyhow::anyhow!(
            "Local file changed after planning; rerun sync: {}",
            item.path
        )
    };
    if fingerprint.size != item.size || fingerprint.mtime_ms != item.mtime_ms.trunc() {
        return Err(changed());
    }

    let (sha256, hashed) = match cached.and_then(|entry| entry.hash_at(&fingerprint)) {
        Some(sha256) => (sha256.to_owned(), None),
        None => {
            status(
                observer,
                format!("[{current}/{total}] hashing {}", item.path),
            );
            let sha256 = hash_reporting(file_path, &item.path, current, total, observer, cancel)?;
            let (after, _) = stat_fingerprint(file_path)?;
            if !fingerprints_match(&fingerprint, &after) {
                return Err(changed());
            }
            (sha256, Some(fingerprint))
        }
    };
    Ok(Prepared {
        sha256,
        hashed,
        before: stat_fingerprint(file_path)?,
    })
}

/// `hashLocalFile`: the file's SHA-256, reporting its bytes every 100 ms.
fn hash_reporting(
    file_path: &Path,
    archive_path: &str,
    current: usize,
    total: usize,
    observer: Option<&Observer>,
    cancel: &CancelToken,
) -> anyhow::Result<String> {
    let size = std::fs::metadata(file_path)?.len();
    let last = std::cell::Cell::new(std::time::Instant::now());
    let report = |bytes: u64| {
        if last.get().elapsed() >= PROGRESS_INTERVAL || bytes == size {
            last.set(std::time::Instant::now());
            status(
                observer,
                format!(
                    "[{current}/{total}] hashing {archive_path} ({} / {})",
                    format::bytes(bytes),
                    format::bytes(size)
                ),
            );
        }
    };
    hash_file_contents(file_path, None, Some(cancel), &report)
}

/// `pushMediaItem`: registers, uploads and records one file under `logical_path`.
async fn push_media_item(
    context: &ItemContext<'_>,
    current: usize,
    plan_path: &str,
    item: &MediaItem,
    (before, before_mtime): Stat,
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
    let sha256 = item
        .sha256
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("{} has no hash", item.path))?;
    let (signing, mut recording) =
        registration(item, logical_path, sha256, before.size, context.sync_run_id)?;

    stage("registering", "requesting upload URL");
    let target = context
        .client
        .upload_url(&signing, Some(context.cancel))
        .await?;

    let upload_url = &target.upload_url;
    let reported = AtomicU64::new(0);
    let report = |sent: u64, of: u64| {
        let before = reported.swap(sent, Ordering::Relaxed);
        context
            .sent
            .fetch_add(sent.saturating_sub(before), Ordering::Relaxed);
        stage(
            "uploading",
            &format!("{} / {}", format::bytes(sent), format::bytes(of)),
        );
    };
    context
        .client
        .upload_file(
            upload_url,
            &target.headers,
            &file_path,
            &signing.content_type,
            sha256,
            before.size,
            &report,
            Some(context.cancel),
        )
        .await?;

    let (after, after_mtime) = stat_fingerprint_async(&file_path).await?;
    if after.size != before.size || after_mtime != before_mtime {
        anyhow::bail!("File changed during sync; retry this item.");
    }

    stage("registering", "recording ingest");
    recording.object_key = target.object_key;
    context
        .client
        .complete_object(&recording, Some(context.cancel))
        .await
}

/// A file's registration under `logical_path`: what asks Pane View for its signed upload URL, and
/// what then records it in the library, once given the storage key Pane View signed.
pub(crate) fn registration(
    item: &MediaItem,
    logical_path: &str,
    sha256: &str,
    size: u64,
    sync_run_id: &str,
) -> anyhow::Result<(types::UploadUrlRequest, types::CompleteObjectRequest)> {
    let filename = get_base_name(logical_path);
    let extension = get_extension(&filename);
    let content_type = content_type_for_extension(&extension).to_owned();
    let signing = types::UploadUrlRequest {
        content_type: content_type.clone(),
        filename: filename.clone(),
        sha256: sha256.to_owned(),
        size: size as f64,
    };
    let recording = types::CompleteObjectRequest {
        content_type,
        extension,
        filename,
        logical_path: logical_path.to_owned(),
        media_type: media_type(item.media_type)?,
        mtime_ms: item.mtime_ms,
        object_key: String::new(),
        sha256: sha256.to_owned(),
        size: size as f64,
        sync_run_id: sync_run_id.to_owned(),
    };
    Ok((signing, recording))
}

/// The registration's media type. The scan lists only supported media, and Pane View refuses
/// anything else.
fn media_type(media_type: MediaType) -> anyhow::Result<types::CompleteObjectRequestMediaType> {
    Ok(match media_type {
        MediaType::Image => types::CompleteObjectRequestMediaType::Image,
        MediaType::Gif => types::CompleteObjectRequestMediaType::Gif,
        MediaType::Video => types::CompleteObjectRequestMediaType::Video,
        MediaType::Pdf => types::CompleteObjectRequestMediaType::Pdf,
        MediaType::Unknown => anyhow::bail!("unsupported media type"),
    })
}
