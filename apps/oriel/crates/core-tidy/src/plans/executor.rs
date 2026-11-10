//! The executor: it applies a reviewed plan step by step
//! and undoes one, newest step first.
//!
//! This is the code that moves the owner's files, so it keeps these guarantees exactly:
//!
//! - each file is read again just before it is touched, and one that changed since the scan (its
//!   size, its mtime, or its ctime unless its bytes still hash the same) is skipped, never acted
//!   on from stale facts;
//! - nothing is deleted: what a step takes out of a root goes to holding, outside the root, and
//!   a conversion's original goes there only once the new file has been checked and is in place;
//! - each step settles on its own, so one failure never stops the rest, and a stopped run leaves
//!   the remaining steps pending;
//! - every finished step can be undone, and an undo never overwrites anything.
//!
//! Identical copies stay identical through a conversion, whichever plan changes them: a step whose
//! source hashes as an earlier step's did, changed the same way, takes that step's result rather
//! than encode again, once its own source and the result both check out. It still has its own
//! original in holding and its own Undo, and clones the result where the disk can, so it depends on
//! the other step for nothing afterwards.
//!
//! The engine runs it on a worker thread; catalog calls go to the catalog's thread one by one.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime};

use anyhow::{Context as _, anyhow, bail};
use oriel_avif::Libavif;
use oriel_core_domain::format;
use oriel_core_domain::is_folder_system_file;
use oriel_core_format::{AudioTrackPlan, VideoTrackPlan};
use oriel_runtime::Cancelled;
use oriel_runtime::fs_meta::{MetadataExt as _, change_time, identity};
use rusqlite::{OptionalExtension as _, params};

use super::encode_budget::EncodeBudget;
use super::holding::{
    HoldRequest, HoldingPlaces, HoldingStore, copy_times, hold_file, holding_batch_name,
    holding_record_by_id, move_file, path_exists, restorable, restore_held,
};
use super::journal::SkipReason;
use super::journal::{
    StepRecord, forget_dismissals_of_idle_plan, load_steps, plan_subject, temp_path_of,
};
use super::planner::{Keeper, StepSpec};
use crate::catalog::files::{
    ConvertedFile, FileIdentity, NotSmaller, file_record_at, forget_empty_folder, forget_file,
    mark_not_smaller as catalog_mark_not_smaller, point_back_at_original, relocate_file,
    replace_converted_file,
};
use crate::catalog::rows::FileRecord;
use crate::catalog::timings::{EncodeTiming, record_encode_timing};
use crate::catalog::{Catalog, now_ms};
use crate::contract::{
    FileFormat, HoldingId, PlanId, PlanKind, PlanStepAction, Root, RootId, StepStatus,
};
use crate::media::convert::{Conversion, Converter, pixels};
use crate::passes::hash::{HashError, hash_edges, hash_whole_file};
use crate::passes::{Media, Progress, run_concurrently};
use crate::paths::is_within;
use crate::scan::{dir_of, whole_ms};
use oriel_tools::{ToolError, probe_video};

/// A conversion is kept only when it saves at least this share of the original's bytes.
const MINIMUM_SAVING: f64 = 0.05;

/// Holding's reason for a `.DS_Store` or `Thumbs.db` that left with the empty folder it was in.
const FOLDER_FILES_REASON: &str = "Left by Finder or Explorer in an empty folder";

/// The same reason as Electron Oriel's engine 0.1.2 to 0.1.4 wrote it, when only `.DS_Store` left with its
/// folder; an undo still brings those back.
const FINDER_SETTINGS_REASON: &str = "Finder's settings for an empty folder";

const CHANGED_SINCE_SCAN: &str = "The file changed since the scan; rescan before changing it.";

const KEPT_FILE_CHANGED: &str = "The file kept instead has changed since the scan.";

const KEPT_FILE_GONE: &str = "The file kept instead is no longer there.";

/// What a step taking an earlier step's result says instead of how it encoded.
pub const SAME_RESULT: &str = "Same result as its identical copy";

/// How a step that kept its original because of the result's size starts saying so.
const KEPT_THE_ORIGINAL: &str = "Kept the original: ";

/// Which mark the plan kinds that keep only a smaller result leave on a file that did not
/// shrink, so they stop offering it.
fn not_smaller_mark(kind: Option<PlanKind>) -> Option<NotSmaller> {
    match kind? {
        PlanKind::Optimize => Some(NotSmaller::Convert),
        PlanKind::ShrinkVideos => Some(NotSmaller::Shrink),
        _ => None,
    }
}

/// What the executor works with.
pub(crate) struct ExecutorDeps<'a> {
    pub catalog: &'a Catalog,
    /// Where each root's held files go.
    pub places: &'a HoldingPlaces,
    pub media: &'a Media,
    /// The AVIF encoder, or why there is none.
    pub libavif: Result<&'a Libavif, String>,
    /// ffmpeg has SVT-AV1, which every AV1 encode uses.
    pub svt_av1: bool,
    /// AVIF encodes run this many at once, within the memory [`EncodeBudget`] allows.
    pub still_concurrency: usize,
    pub encode_budget: &'a EncodeBudget,
    pub roots: Vec<Root>,
    pub progress: &'a dyn Progress,
}

impl ExecutorDeps<'_> {
    fn converter(&self) -> Converter<'_> {
        Converter {
            media: self.media,
            libavif: self.libavif.clone(),
            budget: self.encode_budget,
        }
    }

    fn store(&self) -> HoldingStore<'_> {
        HoldingStore {
            catalog: self.catalog,
            places: self.places,
        }
    }

    fn stopped(&self) -> bool {
        self.progress.check().is_err()
    }
}

/// How one step ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepOutcome {
    Done {
        bytes_after: i64,
        holding_id: Option<HoldingId>,
        message: Option<String>,
        /// The result's SHA-256, for a conversion whose source's bytes were confirmed.
        output_sha256: Option<String>,
    },
    Skipped(String),
    /// Skipped for a reason the plan's summary counts.
    SkippedFor(String, SkipReason),
    Failed(String),
}

/// A step left alone, with why; `stale` when the catalog is out of date for its file, so a scan
/// has to catch it up before it can be tried again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepSkip {
    pub message: String,
    pub stale: bool,
    pub reason: Option<SkipReason>,
}

impl StepSkip {
    fn stale(message: &str) -> anyhow::Error {
        anyhow::Error::new(Self {
            message: message.to_owned(),
            stale: true,
            reason: None,
        })
    }

    /// A duplicate decision's file left alone because the copy kept instead changed or went.
    fn kept_file(reason: SkipReason) -> anyhow::Error {
        let message = match reason {
            SkipReason::KeptFileChanged => KEPT_FILE_CHANGED,
            SkipReason::KeptFileGone => KEPT_FILE_GONE,
        };
        anyhow::Error::new(Self {
            message: message.to_owned(),
            stale: true,
            reason: Some(reason),
        })
    }
}

impl std::fmt::Display for StepSkip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StepSkip {}

/// What applying a plan left for the engine to follow up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ApplyResult {
    /// Steps skipped because their file changed or vanished since the scan.
    pub stale_steps: usize,
}

/// Whether an error is a file another program holds open. Windows will not move or delete such
/// a file, and says so with a sharing violation or a denied access (Node's `EBUSY` and `EPERM`);
/// elsewhere `EPERM` is a locked file or a denied permission, which closing nothing fixes, so
/// only `EBUSY` counts (plan 062).
pub fn is_file_in_use(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<io::Error>().is_some_and(|error| {
            error.kind() == io::ErrorKind::ResourceBusy
                || is_sharing_violation(error)
                || (cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied)
        })
    })
}

/// Windows' `ERROR_SHARING_VIOLATION` and `ERROR_LOCK_VIOLATION`.
fn is_sharing_violation(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33))
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', std::path::MAIN_SEPARATOR])
        .next()
        .unwrap_or(path)
}

/// The root a path lies in, the deepest if roots nest, with the path relative to it.
fn locate(roots: &[Root], abs_path: &Path) -> Option<(RootId, String)> {
    let root = roots
        .iter()
        .filter(|root| is_within(abs_path, Path::new(&root.path)))
        .max_by_key(|root| root.path.len())?;
    let relative = abs_path.strip_prefix(&root.path).ok()?;
    Some((
        root.id,
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
    ))
}

/// Whether `path` still has the size and dates it had when `before` and its change time were read.
/// On Windows the change time is only read from the path, so it cannot come from `before` now.
fn same_file_state(path: &Path, before: &fs::Metadata, change_time_before: i64) -> bool {
    fs::metadata(path).is_ok_and(|now| {
        now.size() == before.size()
            && whole_mtime(&now) == whole_mtime(before)
            && whole_ctime(path, &now) == change_time_before
    })
}

fn whole_mtime(metadata: &fs::Metadata) -> i64 {
    whole_ms(metadata.mtime(), metadata.mtime_nsec())
}

/// Node's `ctimeMs` of `path` in whole milliseconds: on Windows NTFS's change time, which only a
/// read of the path gives (`fs_meta::change_time`).
fn whole_ctime(path: &Path, metadata: &fs::Metadata) -> i64 {
    let (seconds, nanoseconds) = change_time(path, metadata);
    whole_ms(seconds, nanoseconds)
}

/// Re-reads the source just before touching it. A file that changed since the scan (size, mtime
/// or ctime) or vanished is skipped. When only the ctime moved, as when a sync client tags a file
/// it sees arrive, the bytes decide: a file that still hashes to the catalog's SHA-256 is the
/// file the plan was drafted for.
fn check_source(deps: &ExecutorDeps<'_>, step: &StepRecord) -> anyhow::Result<fs::Metadata> {
    let source = step.source_path();
    let Ok(current) = fs::symlink_metadata(&source) else {
        return Err(StepSkip::stale("The file is no longer there."));
    };
    if !current.is_file()
        || current.size() as i64 != step.expected_size
        || whole_mtime(&current) != step.expected_mtime_ms.trunc() as i64
    {
        return Err(StepSkip::stale(CHANGED_SINCE_SCAN));
    }
    if whole_ctime(&source, &current) != step.expected_ctime_ms.trunc() as i64
        && !holds_catalogued_bytes(deps, step, &current)?
    {
        return Err(StepSkip::stale(CHANGED_SINCE_SCAN));
    }
    Ok(fs::symlink_metadata(&source)?)
}

/// Re-reads what a duplicate goes in favour of, just before it goes, as [`check_source`] does the
/// file itself. Any of them changed or gone, and the page or the answers it rested on are out of
/// date: the step is skipped, and the scan that catches them up follows.
fn check_keepers(deps: &ExecutorDeps<'_>, keepers: &[Keeper]) -> anyhow::Result<()> {
    for keeper in keepers {
        let path = Path::new(&keeper.path);
        let Ok(current) = fs::symlink_metadata(path) else {
            return Err(StepSkip::kept_file(SkipReason::KeptFileGone));
        };
        if !current.is_file()
            || current.size() as i64 != keeper.size
            || whole_mtime(&current) != keeper.mtime_ms.trunc() as i64
        {
            return Err(StepSkip::kept_file(SkipReason::KeptFileChanged));
        }
        if whole_ctime(path, &current) != keeper.ctime_ms.trunc() as i64
            && !hashes_to(deps, path, &current, keeper.sha256.as_deref())?
        {
            return Err(StepSkip::kept_file(SkipReason::KeptFileChanged));
        }
    }
    Ok(())
}

/// Whether the file still hashes to the SHA-256 the catalog has for it; false without one.
fn holds_catalogued_bytes(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    current: &fs::Metadata,
) -> anyhow::Result<bool> {
    let catalogued = catalogued_record(deps, step)?.and_then(|record| record.sha256);
    hashes_to(deps, &step.source_path(), current, catalogued.as_deref())
}

/// Whether a file's bytes hash to `sha256`; false without one, or unread.
fn hashes_to(
    deps: &ExecutorDeps<'_>,
    path: &Path,
    current: &fs::Metadata,
    sha256: Option<&str>,
) -> anyhow::Result<bool> {
    let Some(sha256) = sha256 else {
        return Ok(false);
    };
    let expected = (
        current.size() as i64,
        whole_mtime(current) as f64,
        whole_ctime(path, current) as f64,
    );
    match hash_whole_file(path, expected, deps.progress) {
        Ok(hashed) => Ok(hashed == sha256),
        Err(HashError::Cancelled) => Err(Cancelled.into()),
        Err(HashError::Unreadable) => Ok(false),
    }
}

/// The catalog's row of a step's source.
fn catalogued_record(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
) -> anyhow::Result<Option<FileRecord>> {
    let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
    deps.catalog
        .blocking(move |connection| file_record_at(connection, root_id, &rel_path))
}

/// Where a file now on disk is, as the catalog records it.
fn identity_of(path: &Path, metadata: &fs::Metadata) -> FileIdentity {
    let identity = identity(path, metadata);
    FileIdentity {
        ctime_ms: whole_ms(identity.ctime, identity.ctime_nsec),
        dev: identity.dev.to_string(),
        ino: identity.ino.to_string(),
    }
}

/// Points a catalog row at a file's new path when the bytes did not change (move, rename). A
/// file moved out of every root leaves the catalog.
fn relocate_row(
    deps: &ExecutorDeps<'_>,
    root_id: RootId,
    from: &str,
    target: &Path,
) -> anyhow::Result<()> {
    let from = from.to_owned();
    let Some((new_root, rel_path)) = locate(&deps.roots, target) else {
        return deps
            .catalog
            .blocking(move |connection| forget_file(connection, root_id, &from));
    };
    let identity = identity_of(target, &fs::metadata(target)?);
    deps.catalog.blocking(move |connection| {
        relocate_file(
            connection,
            (root_id, &from),
            (new_root, &rel_path),
            &identity,
        )
    })
}

/// What a conversion's check found in the file it wrote.
#[derive(Clone, Debug, PartialEq)]
struct OutputFacts {
    format: FileFormat,
    kind: &'static str,
    width: Option<i64>,
    height: Option<i64>,
    frames: Option<i64>,
    duration_ms: Option<f64>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    audio_streams: Option<i64>,
    bitrate: Option<f64>,
}

/// The hashes of a conversion's result, written when its source was one of a possible set of
/// copies. The hash pass only runs in a scan, and the set must not wait for one to hold together.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OutputHashes {
    head_hash: String,
    sha256: String,
}

/// What rewriting a converted file's row records besides the file itself.
struct ReplacedRow {
    facts: OutputFacts,
    /// The conversion carried the audio track over, so the track's loudness measurement stands.
    keep_loudness: bool,
    hashes: Option<OutputHashes>,
    /// The result was kept for being smaller, so it counts as re-encoded to save space.
    reencoded: bool,
}

/// Rewrites a catalog row for a converted file; see [`replace_converted_file`].
fn replace_row(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    target: &Path,
    replaced: ReplacedRow,
) -> anyhow::Result<()> {
    let ReplacedRow {
        facts,
        keep_loudness,
        hashes,
        reencoded,
    } = replaced;
    let Some((_, rel_path)) = locate(&deps.roots, target) else {
        return Ok(());
    };
    let written = fs::metadata(target)?;
    let file = ConvertedFile {
        rel_path,
        size: written.size() as i64,
        mtime_ms: whole_mtime(&written),
        identity: identity_of(target, &written),
        kind: facts.kind,
        format: facts.format,
        width: facts.width,
        height: facts.height,
        frames: facts.frames,
        duration_ms: facts.duration_ms,
        video_codec: facts.video_codec,
        audio_codec: facts.audio_codec,
        audio_streams: facts.audio_streams,
        bitrate: facts.bitrate,
        hashes: hashes.map(|hashes| (hashes.head_hash, hashes.sha256)),
        keep_loudness,
        reencoded,
    };
    let (root_id, from) = (step.root_id, step.from_rel.clone());
    deps.catalog
        .blocking(move |connection| replace_converted_file(connection, root_id, &from, &file))
}

/// After a conversion's undo, points its row back at the original; see
/// [`point_back_at_original`].
fn point_row_at_original(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    target: &Path,
) -> anyhow::Result<()> {
    let Some((_, rel_path)) = locate(&deps.roots, target) else {
        return Ok(());
    };
    let (root_id, from) = (step.root_id, step.from_rel.clone());
    deps.catalog
        .blocking(move |connection| point_back_at_original(connection, root_id, &rel_path, &from))
}

/// What the catalog knew of the source, which the conversion's result is checked against.
#[derive(Clone, Copy, Debug, Default)]
struct SourceFacts {
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<f64>,
    audio_streams: Option<i64>,
}

fn source_facts(deps: &ExecutorDeps<'_>, step: &StepRecord) -> anyhow::Result<SourceFacts> {
    Ok(catalogued_record(deps, step)?
        .map(|record| SourceFacts {
            width: record.width,
            height: record.height,
            duration_ms: record.duration_ms,
            audio_streams: record.audio_streams,
        })
        .unwrap_or_default())
}

fn close_to(actual: Option<f64>, expected: Option<f64>, tolerance: f64) -> bool {
    matches!((actual, expected), (Some(actual), Some(expected)) if (actual - expected).abs() <= tolerance)
}

fn show(value: Option<impl std::fmt::Display>) -> String {
    value.map_or_else(|| "null".to_owned(), |value| value.to_string())
}

/// How one conversion runs and what it records.
struct ConvertContext<'a> {
    batch: &'a str,
    source: &'a fs::Metadata,
    /// Keep the result only when it saves at least [`MINIMUM_SAVING`].
    require_smaller: bool,
    /// Marks a file whose result was not kept for that, so it is not offered again.
    not_smaller: Option<NotSmaller>,
    /// The result carries the original's audio track unchanged.
    keep_loudness: bool,
}

/// Removes a conversion's temp file however the conversion ends.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// A file's size and dates, as a hash checks it did not change while being read.
fn expected_of(path: &Path, metadata: &fs::Metadata) -> (i64, f64, f64) {
    (
        metadata.size() as i64,
        whole_mtime(metadata) as f64,
        whole_ctime(path, metadata) as f64,
    )
}

/// The file's SHA-256 as it is now, or `None` if it cannot be read through.
fn hash_of(deps: &ExecutorDeps<'_>, path: &Path) -> anyhow::Result<Option<String>> {
    let metadata = fs::metadata(path)?;
    match hash_whole_file(path, expected_of(path, &metadata), deps.progress) {
        Ok(sha256) => Ok(Some(sha256)),
        Err(HashError::Cancelled) => Err(Cancelled.into()),
        Err(HashError::Unreadable) => Ok(None),
    }
}

/// A result an earlier step made from the same bytes, the same way.
struct EarlierResult {
    output: PathBuf,
    sha256: String,
    bytes: i64,
    /// Where that step's original went.
    held: Option<PathBuf>,
}

/// The results of steps, in any plan, that made this conversion from the same bytes, newest first.
/// A step that was undone, or whose file has since changed, offers nothing.
fn earlier_results(
    deps: &ExecutorDeps<'_>,
    sha256: &str,
    spec: &str,
) -> anyhow::Result<Vec<EarlierResult>> {
    let (sha256, spec) = (sha256.to_owned(), spec.to_owned());
    deps.catalog.blocking(move |connection| {
        let mut statement = connection.prepare_cached(
            "SELECT s.to_abs, s.output_sha256, s.bytes_after, h.hold_path FROM plan_steps s
          LEFT JOIN holding h ON h.id = s.holding_id AND h.state = 'held'
          WHERE s.source_sha256 = ?1 AND s.spec = ?2 AND s.status = 'done'
            AND s.output_sha256 IS NOT NULL AND s.to_abs IS NOT NULL
          ORDER BY s.id DESC",
        )?;
        let rows = statement.query_map(params![sha256, spec], |row| {
            Ok(EarlierResult {
                output: PathBuf::from(row.get::<_, String>(0)?),
                sha256: row.get(1)?,
                bytes: row.get(2)?,
                held: row.get::<_, Option<String>>(3)?.map(PathBuf::from),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
}

/// Whether two paths are one file on disk.
fn same_inode(left: &Path, right: &Path) -> bool {
    let of = |path: &Path| {
        fs::metadata(path).map(|metadata| {
            let identity = identity(path, &metadata);
            (identity.dev, identity.ino)
        })
    };
    matches!((of(left), of(right)), (Ok(left), Ok(right)) if left == right)
}

/// Takes an earlier step's result into `temp` and checks it as an encode's is checked, or says none
/// would do. The disk's cheapest copy: a hard link when the two sources were hard links of one
/// file, so the results are too and no new duplicate appears, otherwise `fs::copy`, which clones
/// where the system and the volume can (APFS, ReFS, btrfs) and copies where not.
fn take_earlier_result(
    deps: &ExecutorDeps<'_>,
    source: &Path,
    earlier: &EarlierResult,
    temp: &Path,
    verify: &impl Fn(&Path) -> anyhow::Result<OutputFacts>,
) -> anyhow::Result<Option<OutputFacts>> {
    let unusable = || {
        let _ = fs::remove_file(temp);
        Ok(None)
    };
    if !fs::metadata(&earlier.output).is_ok_and(|output| output.size() as i64 == earlier.bytes) {
        return Ok(None);
    }
    let _ = fs::remove_file(temp);
    let linked = earlier
        .held
        .as_deref()
        .is_some_and(|held| same_inode(held, source))
        && fs::hard_link(&earlier.output, temp).is_ok();
    if !linked && fs::copy(&earlier.output, temp).is_err() {
        return unusable();
    }
    if hash_of(deps, temp)?.as_deref() != Some(earlier.sha256.as_str()) {
        return unusable();
    }
    match verify(temp) {
        Ok(facts) => Ok(Some(facts)),
        Err(error) if error.is::<Cancelled>() || deps.stopped() => Err(error),
        Err(_) => unusable(),
    }
}

/// How an earlier step of the same bytes ended in keeping its original, if one did: the same
/// bytes the same way would not come out any smaller.
fn earlier_not_smaller(
    deps: &ExecutorDeps<'_>,
    sha256: &str,
    spec: &str,
) -> anyhow::Result<Option<String>> {
    let (sha256, spec) = (sha256.to_owned(), spec.to_owned());
    deps.catalog.blocking(move |connection| {
        Ok(connection
            .query_row(
                "SELECT message FROM plan_steps WHERE source_sha256 = ?1 AND spec = ?2
              AND status = 'skipped' AND message LIKE ?3 ORDER BY id DESC LIMIT 1",
                params![sha256, spec, format!("{KEPT_THE_ORIGINAL}%")],
                |row| row.get(0),
            )
            .optional()?)
    })
}

fn mark_not_smaller(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    not_smaller: Option<NotSmaller>,
) -> anyhow::Result<()> {
    if let Some(mark) = not_smaller {
        let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
        deps.catalog.blocking(move |connection| {
            catalog_mark_not_smaller(connection, mark, root_id, &rel_path)
        })?;
    }
    Ok(())
}

/// Writes a conversion to a temp file, checks it with `verify`, gives it the original's dates,
/// puts it in place and moves the original to holding. When the target is the original's own
/// path (re-encoding an MP4), the original leaves first. A step whose source has identical copies
/// takes the result an earlier one made, if it passes the checks, and otherwise runs `produce`.
fn convert(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    context: ConvertContext<'_>,
    produce: impl FnOnce(&Path) -> anyhow::Result<Option<String>>,
    verify: impl Fn(&Path) -> anyhow::Result<OutputFacts>,
) -> anyhow::Result<StepOutcome> {
    let Some(target) = step.to_abs.as_deref().map(PathBuf::from) else {
        return Ok(StepOutcome::Failed("The step has no target.".into()));
    };
    let source = step.source_path();
    let source_change_time = whole_ctime(&source, context.source);
    let same_path = std::path::absolute(&target)? == std::path::absolute(&source)?;
    if !same_path && path_exists(&target) {
        return Ok(StepOutcome::Skipped(format!(
            "{} already exists.",
            base_name(&target.to_string_lossy())
        )));
    }
    let temp = TempFile(PathBuf::from(temp_path_of(&target.to_string_lossy())));
    let spec = serde_json::to_string(&step.spec)?;
    // Copies are told by the catalog's hash, which is checked against the bytes before they are
    // given another file's result, or offer theirs to another.
    let confirmed = match step.source_sha256.as_deref() {
        Some(sha256) if hash_of(deps, &source)?.as_deref() == Some(sha256) => Some(sha256),
        _ => None,
    };

    if context.require_smaller
        && let Some(sha256) = confirmed
        && let Some(message) = earlier_not_smaller(deps, sha256, &spec)?
    {
        mark_not_smaller(deps, step, context.not_smaller)?;
        return Ok(StepOutcome::Skipped(message));
    }
    let mut reused = None;
    if let Some(sha256) = confirmed {
        for earlier in earlier_results(deps, sha256, &spec)? {
            if let Some(facts) = take_earlier_result(deps, &source, &earlier, &temp.0, &verify)? {
                reused = Some((facts, earlier.sha256));
                break;
            }
        }
    }
    let (note, facts, output_sha256) = match reused {
        Some((facts, sha256)) => (Some(SAME_RESULT.to_owned()), facts, Some(sha256)),
        None => {
            let note = produce(&temp.0)?;
            let facts = verify(&temp.0)?;
            let sha256 = match confirmed {
                Some(_) => hash_of(deps, &temp.0)?,
                None => None,
            };
            (note, facts, sha256)
        }
    };
    // A source another program changed meanwhile: the result is not of the bytes that were read, so
    // it neither replaces them nor is offered to their other copies. A scan catches up.
    if !same_file_state(&source, context.source, source_change_time) {
        return Err(StepSkip::stale(CHANGED_SINCE_SCAN));
    }
    let written = fs::metadata(&temp.0)?.size();
    let original = context.source.size();

    if context.require_smaller && written as f64 > original as f64 * (1.0 - MINIMUM_SAVING) {
        fs::remove_file(&temp.0)?;
        mark_not_smaller(deps, step, context.not_smaller)?;
        let why = if written > original {
            "the result was larger"
        } else {
            "it saved less than 5%"
        };
        return Ok(StepOutcome::Skipped(format!(
            "{KEPT_THE_ORIGINAL}{why} ({} → {})",
            format::bytes(original),
            format::bytes(written)
        )));
    }

    copy_times(&temp.0, context.source)?;
    let hashes = match &output_sha256 {
        Some(sha256) => Some(OutputHashes {
            head_hash: hash_edges(&temp.0, written)?,
            sha256: sha256.clone(),
        }),
        None => None,
    };

    let reason = format!("Replaced by {}", base_name(&target.to_string_lossy()));
    let hold = || {
        hold_file(
            deps.store(),
            &HoldRequest {
                root_id: step.root_id,
                root_path: &step.root_path,
                rel_path: &step.from_rel,
                batch: context.batch,
                plan_id: Some(step.plan_id),
                reason: &reason,
            },
        )
    };

    let holding_id = if same_path {
        let holding_id = hold()?;
        if let Err(error) = move_file(&temp.0, &target) {
            restore_held(deps.store(), holding_id)?;
            return Err(error.into());
        }
        holding_id
    } else {
        move_file(&temp.0, &target)?;
        match hold() {
            Ok(holding_id) => holding_id,
            Err(error) => {
                // The original could not be held (on Windows, open in another program): take the
                // new file back out, which nothing was at before, so the step leaves things as it
                // found them. An original already in holding (its record failed) keeps the new
                // file in its place.
                if path_exists(&source)
                    && let Err(removing) = fs::remove_file(&target)
                {
                    log::warn!(
                        "Tidy could not take {} back out after holding its original failed: \
                         {removing}",
                        target.display()
                    );
                }
                return Err(error);
            }
        }
    };

    replace_row(
        deps,
        step,
        &target,
        ReplacedRow {
            facts,
            keep_loudness: context.keep_loudness,
            hashes,
            reencoded: context.require_smaller,
        },
    )?;
    Ok(StepOutcome::Done {
        bytes_after: written as i64,
        holding_id: Some(holding_id),
        message: note,
        output_sha256,
    })
}

fn tool_error(error: ToolError) -> anyhow::Error {
    match error {
        ToolError::Cancelled => Cancelled.into(),
        error => anyhow!("{error}"),
    }
}

fn remove_folder(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    batch: &str,
) -> anyhow::Result<StepOutcome> {
    let folder = step.source_path();
    let Ok(entries) = fs::read_dir(&folder) else {
        return Ok(StepOutcome::Skipped(
            "The folder is no longer there.".into(),
        ));
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    // Node's `readdir` lists names in byte order.
    names.sort();
    // Finder's and Explorer's files are not catalogued, so they go to holding with their folder.
    let system_files: Vec<&String> = names
        .iter()
        .filter(|name| is_folder_system_file(name))
        .collect();
    if names.len() > system_files.len() {
        return Ok(StepOutcome::Skipped(
            "The folder is no longer empty.".into(),
        ));
    }
    for name in system_files {
        hold_file(
            deps.store(),
            &HoldRequest {
                root_id: step.root_id,
                root_path: &step.root_path,
                rel_path: &format!("{}/{name}", step.from_rel),
                batch,
                plan_id: Some(step.plan_id),
                reason: FOLDER_FILES_REASON,
            },
        )?;
    }
    remove_empty_folder(&folder)?;
    let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
    deps.catalog
        .blocking(move |connection| forget_empty_folder(connection, root_id, &rel_path))?;
    Ok(StepOutcome::Done {
        bytes_after: 0,
        holding_id: None,
        message: None,
        output_sha256: None,
    })
}

#[cfg(not(windows))]
fn remove_empty_folder(folder: &Path) -> io::Result<()> {
    fs::remove_dir(folder)
}

/// Removes an emptied folder. Explorer marks a customized folder (one with a `desktop.ini`)
/// read-only, and Windows can take that as a refusal; Node's `rmdir` removed such a folder in plan
/// 062's checks, so when the mark is what refuses, it comes off, and goes back if the folder
/// stays all the same.
#[cfg(windows)]
// On Windows `set_readonly(false)` clears the read-only attribute and nothing else.
#[allow(clippy::permissions_set_readonly_false)]
fn remove_empty_folder(folder: &Path) -> io::Result<()> {
    match fs::remove_dir(folder) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            let mut permissions = fs::metadata(folder)?.permissions();
            if !permissions.readonly() {
                return Err(error);
            }
            permissions.set_readonly(false);
            fs::set_permissions(folder, permissions.clone())?;
            fs::remove_dir(folder).inspect_err(|_| {
                permissions.set_readonly(true);
                let _ = fs::set_permissions(folder, permissions);
            })
        }
        removed => removed,
    }
}

fn execute_step(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    batch: &str,
    not_smaller: Option<NotSmaller>,
) -> anyhow::Result<StepOutcome> {
    if step.spec == StepSpec::RemoveFolder {
        return remove_folder(deps, step, batch);
    }
    let source = check_source(deps, step)?;
    if cfg!(windows)
        && matches!(
            step.spec,
            StepSpec::ConvertAvif
                | StepSpec::ConvertAnimation { .. }
                | StepSpec::ConvertVideo { .. }
        )
    {
        // A file another program holds without sharing still answers `check_source`, which
        // reads only attributes; libvips and ffmpeg would then call it an unknown format. One
        // open here gives Windows' sharing violation, which `is_file_in_use` reads. Any other
        // failure, such as a denied permission, is the file's own and must not read as in use.
        if let Err(error) = fs::File::open(step.source_path()) {
            if is_sharing_violation(&error) {
                return Err(error.into());
            }
            bail!("{error}");
        }
    }

    match &step.spec {
        StepSpec::RemoveFolder => unreachable!("handled above"),
        StepSpec::Hold { reason, keepers } => {
            check_keepers(deps, keepers)?;
            let holding_id = hold_file(
                deps.store(),
                &HoldRequest {
                    root_id: step.root_id,
                    root_path: &step.root_path,
                    rel_path: &step.from_rel,
                    batch,
                    plan_id: Some(step.plan_id),
                    reason,
                },
            )?;
            let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
            deps.catalog
                .blocking(move |connection| forget_file(connection, root_id, &rel_path))?;
            Ok(StepOutcome::Done {
                bytes_after: 0,
                holding_id: Some(holding_id),
                message: None,
                output_sha256: None,
            })
        }
        StepSpec::Move | StepSpec::Rename => {
            let Some(target) = step.to_abs.as_deref().map(PathBuf::from) else {
                return Ok(StepOutcome::Failed("The step has no target.".into()));
            };
            if std::path::absolute(&target)? != std::path::absolute(step.source_path())?
                && path_exists(&target)
            {
                return Ok(StepOutcome::Skipped(format!(
                    "{} already exists there.",
                    base_name(&target.to_string_lossy())
                )));
            }
            move_file(&step.source_path(), &target)?;
            relocate_row(deps, step.root_id, &step.from_rel, &target)?;
            Ok(StepOutcome::Done {
                bytes_after: source.size() as i64,
                holding_id: None,
                message: None,
                output_sha256: None,
            })
        }
        StepSpec::ConvertAvif => {
            let expected = source_facts(deps, step)?;
            let vips = deps
                .media
                .loaded_vips()
                .context("libvips is unavailable, so stills cannot be converted.")?;
            deps.libavif.clone().map_err(|error| anyhow!(error))?;
            convert(
                deps,
                step,
                ConvertContext {
                    batch,
                    source: &source,
                    require_smaller: true,
                    not_smaller,
                    keep_loudness: false,
                },
                |temp| {
                    let pixels = pixels(expected.width, expected.height);
                    deps.converter().convert(
                        Conversion::Still { pixels },
                        &step.source_path(),
                        temp,
                        deps.progress,
                        &|_| {},
                    )?;
                    Ok(None)
                },
                |temp| {
                    let probe = vips.probe(temp)?;
                    let (width, height) = (i64::from(probe.width), i64::from(probe.height));
                    if !close_to(
                        Some(width as f64),
                        expected.width.map(|width| width as f64),
                        1.0,
                    ) || !close_to(
                        Some(height as f64),
                        expected.height.map(|height| height as f64),
                        1.0,
                    ) {
                        bail!(
                            "The AVIF came out {width}×{height}, not {}×{}.",
                            show(expected.width),
                            show(expected.height)
                        );
                    }
                    Ok(OutputFacts {
                        format: FileFormat::Avif,
                        kind: "image",
                        width: Some(width),
                        height: Some(height),
                        frames: Some(1),
                        duration_ms: None,
                        video_codec: None,
                        audio_codec: None,
                        audio_streams: None,
                        bitrate: None,
                    })
                },
            )
        }
        StepSpec::ConvertAnimation { .. } | StepSpec::ConvertVideo { .. } => {
            let Some(ffprobe) = deps.media.ffprobe.as_deref() else {
                return Ok(StepOutcome::Failed(
                    "ffprobe is unavailable, so the result cannot be checked.".into(),
                ));
            };
            if deps.media.ffmpeg.is_none() {
                return Ok(StepOutcome::Failed(
                    "ffmpeg is unavailable, so the file cannot be converted.".into(),
                ));
            }
            let expected = source_facts(deps, step)?;
            let animation = matches!(step.spec, StepSpec::ConvertAnimation { .. });
            let (tracks, quality, require_smaller) = match &step.spec {
                StepSpec::ConvertVideo {
                    video,
                    audio,
                    quality,
                    require_smaller,
                } => (Some((*video, *audio)), *quality, *require_smaller),
                _ => (None, crate::contract::VideoQuality::High, false),
            };
            let audio = tracks.map(|(_, audio)| audio);
            let svt = deps.svt_av1
                && matches!(
                    tracks,
                    Some((
                        VideoTrackPlan::Encode {
                            codec: oriel_core_format::ArchiveVideoCodec::Av1
                        },
                        _
                    ))
                );
            let source_path = step.source_path();
            let cancel = deps.progress.cancel_token();
            let known_length = expected.duration_ms.is_some_and(|length| length > 0.);
            let verify =
                |temp: &Path| verify_video(ffprobe, temp, expected, animation, audio, cancel);
            let context = ConvertContext {
                batch,
                source: &source,
                // An animation is converted only to save space.
                require_smaller: if svt {
                    require_smaller
                } else {
                    animation || require_smaller
                },
                not_smaller,
                keep_loudness: audio == Some(AudioTrackPlan::Copy),
            };
            convert(
                deps,
                step,
                context,
                |temp| {
                    let conversion = match tracks {
                        Some((video, audio)) => Conversion::Video {
                            video,
                            audio,
                            quality,
                        },
                        None => Conversion::Animation,
                    };
                    let started = Instant::now();
                    // Encoding a video can take minutes, so it says which and how far along.
                    let name = step.from_rel.as_str();
                    deps.progress.item(Some((name, known_length.then_some(0.))));
                    let on_seconds = |seconds: f64| {
                        let share = expected
                            .duration_ms
                            .filter(|length| *length > 0.)
                            .map(|length| (seconds * 1000. / length).clamp(0., 1.) as f32);
                        deps.progress.item(Some((name, share)));
                    };
                    deps.converter().convert(
                        conversion,
                        &source_path,
                        temp,
                        deps.progress,
                        &on_seconds,
                    )?;
                    if !svt {
                        return Ok(None);
                    }
                    // Timed whether or not the result is kept: the time was spent either way.
                    if let (Some(width), Some(height), Some(duration_ms)) =
                        (expected.width, expected.height, expected.duration_ms)
                    {
                        let timing = EncodeTiming {
                            pixels: (width * height) as f64,
                            media_ms: duration_ms,
                            wall_ms: started.elapsed().as_secs_f64() * 1000.0,
                        };
                        deps.catalog
                            .blocking(move |connection| record_encode_timing(connection, timing))?;
                    }
                    Ok(Some("Encoded with SVT-AV1".to_owned()))
                },
                verify,
            )
        }
    }
}

/// Checks a video or animation conversion's result: a picture, the
/// source's length (within half a second, a quarter for an animation, or 2%), its size (within
/// 2 pixels), its sound when it had some, and no sound when the plan dropped it.
fn verify_video(
    ffprobe: &Path,
    temp: &Path,
    expected: SourceFacts,
    animation: bool,
    audio: Option<AudioTrackPlan>,
    cancel: Option<&oriel_runtime::CancelToken>,
) -> anyhow::Result<OutputFacts> {
    let probe = probe_video(ffprobe, temp, cancel).map_err(tool_error)?;
    let floor: f64 = if animation { 250.0 } else { 500.0 };
    let tolerance = floor.max(expected.duration_ms.unwrap_or(0.0) * 0.02);
    let Some(video_codec) = probe.video_codec.clone() else {
        bail!("The result has no video track.");
    };
    if !close_to(probe.duration_ms, expected.duration_ms, tolerance) {
        bail!(
            "The result lasts {} ms instead of {} ms.",
            show(probe.duration_ms),
            show(expected.duration_ms)
        );
    }
    let near = |actual: Option<i64>, wanted: Option<i64>| {
        close_to(
            actual.map(|value| value as f64),
            wanted.map(|value| value as f64),
            2.0,
        )
    };
    if !near(probe.width, expected.width) || !near(probe.height, expected.height) {
        bail!(
            "The result is {}×{}, not {}×{}.",
            show(probe.width),
            show(probe.height),
            show(expected.width),
            show(expected.height)
        );
    }
    let dropped_audio = audio == Some(AudioTrackPlan::Drop);
    if dropped_audio && probe.audio_streams > 0 {
        bail!("The result still has audio.");
    }
    if !animation
        && !dropped_audio
        && expected.audio_streams.unwrap_or(0) > 0
        && probe.audio_streams == 0
    {
        bail!("The result lost its audio.");
    }
    Ok(OutputFacts {
        format: FileFormat::Mp4,
        kind: "video",
        width: probe.width,
        height: probe.height,
        frames: None,
        duration_ms: probe.duration_ms,
        video_codec: Some(video_codec),
        audio_codec: probe.audio_codec,
        audio_streams: Some(probe.audio_streams),
        bitrate: probe.bitrate,
    })
}

fn record_outcome(catalog: &Catalog, step_id: i64, outcome: StepOutcome) -> anyhow::Result<()> {
    catalog.blocking(move |connection| {
        match outcome {
            StepOutcome::Done {
                bytes_after,
                holding_id,
                message,
                output_sha256,
            } => connection.execute(
                "UPDATE plan_steps SET status = 'done', message = ?1, bytes_after = ?2,
            holding_id = ?3, done_at = ?4, output_sha256 = ?5 WHERE id = ?6",
                params![
                    message,
                    bytes_after,
                    holding_id,
                    now_ms(),
                    output_sha256,
                    step_id
                ],
            )?,
            StepOutcome::Skipped(message) => connection.execute(
                "UPDATE plan_steps SET status = 'skipped', message = ?1 WHERE id = ?2",
                params![message, step_id],
            )?,
            StepOutcome::SkippedFor(message, reason) => connection.execute(
                "UPDATE plan_steps SET status = 'skipped', message = ?1, reason = ?2 WHERE id = ?3",
                params![message, reason.code(), step_id],
            )?,
            StepOutcome::Failed(message) => connection.execute(
                "UPDATE plan_steps SET status = 'failed', message = ?1 WHERE id = ?2",
                params![message, step_id],
            )?,
        };
        Ok(())
    })
}

fn settle_plan(catalog: &Catalog, plan_id: PlanId, cancelled: bool) -> anyhow::Result<()> {
    catalog.blocking(move |connection| {
        let (failed, done): (Option<i64>, Option<i64>) = connection.query_row(
            "SELECT SUM(status = 'failed') AS failed, SUM(status = 'done') AS done
        FROM plan_steps WHERE plan_id = ?1",
            [plan_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let status = if cancelled {
            "cancelled"
        } else if failed.unwrap_or(0) == 0 {
            "applied"
        } else if done.unwrap_or(0) == 0 {
            "failed"
        } else {
            "partial"
        };
        connection.execute(
            "UPDATE plans SET status = ?1 WHERE id = ?2",
            params![status, plan_id],
        )?;
        forget_dismissals_of_idle_plan(connection, plan_id)
    })
}

/// What the progress of an apply says while a step of this action runs. Shrink runs the step
/// Convert's videos do, but to make AV1 and save space.
pub fn describe_action(action: PlanStepAction, kind: Option<PlanKind>) -> &'static str {
    match action {
        PlanStepAction::Hold => "Moving files to holding",
        PlanStepAction::Move => "Moving files",
        PlanStepAction::Rename => "Renaming files",
        PlanStepAction::ConvertAvif => "Converting stills to AVIF",
        PlanStepAction::ConvertAnimation => "Converting animations to MP4",
        PlanStepAction::ConvertVideo if kind == Some(PlanKind::ShrinkVideos) => "Shrinking videos",
        PlanStepAction::ConvertVideo => "Converting videos to MP4",
        PlanStepAction::RemoveFolder => "Removing empty folders",
    }
}

/// Steps done of all, reported with the label of the step that just finished.
struct StepCount<'a> {
    progress: &'a dyn Progress,
    total: u64,
    done: Mutex<u64>,
}

impl StepCount<'_> {
    fn finished(&self, label: &str) {
        let mut done = self.done.lock().unwrap_or_else(|error| error.into_inner());
        *done += 1;
        self.progress.phase(label, self.total);
        self.progress.done(*done);
    }
}

/// Applies a reviewed plan. AVIF encodes run several at once; every other step runs in order, so
/// a folder's junk leaves before the folder does. Each step settles on its own, and a stopped run
/// leaves the remaining steps pending and the plan `cancelled`.
pub(crate) fn apply_plan(deps: &ExecutorDeps<'_>, plan_id: PlanId) -> anyhow::Result<ApplyResult> {
    let (steps, kind) = deps.catalog.blocking(move |connection| {
        connection.execute(
            "UPDATE plans SET status = 'applying' WHERE id = ?1",
            [plan_id],
        )?;
        let steps = load_steps(connection, plan_id, StepStatus::Pending, false)?;
        let kind = plan_subject(connection, plan_id)?.map(|subject| subject.kind);
        Ok((steps, kind))
    })?;
    let batch = holding_batch_name(Some(plan_id), SystemTime::now());
    let not_smaller = not_smaller_mark(kind);
    let stale = AtomicUsize::new(0);
    let count = StepCount {
        progress: deps.progress,
        total: steps.len() as u64,
        done: Mutex::new(0),
    };
    deps.progress.phase(
        steps
            .first()
            .map_or("Changing files", |step| describe_action(step.action, kind)),
        steps.len() as u64,
    );

    let run = |step: &StepRecord| -> anyhow::Result<()> {
        let outcome = match execute_step(deps, step, &batch, not_smaller) {
            Ok(outcome) => outcome,
            Err(error) if deps.stopped() => return Err(error),
            Err(error) => match error.downcast_ref::<StepSkip>() {
                Some(skip) => {
                    if skip.stale {
                        stale.fetch_add(1, Ordering::AcqRel);
                    }
                    match skip.reason {
                        Some(reason) => StepOutcome::SkippedFor(skip.message.clone(), reason),
                        None => StepOutcome::Skipped(skip.message.clone()),
                    }
                }
                None if is_file_in_use(&error) => StepOutcome::Failed(format!(
                    "Another program has {} open, so it was left as it was.",
                    base_name(&step.from_rel)
                )),
                None => StepOutcome::Failed(format!("{error:#}")),
            },
        };
        record_outcome(deps.catalog, step.id, outcome)?;
        if step.action != PlanStepAction::ConvertAvif {
            deps.progress.item(None);
        }
        count.finished(describe_action(step.action, kind));
        Ok(())
    };

    let outcome = (|| -> anyhow::Result<()> {
        // The first still of each set of copies encodes; the rest then take its result.
        let mut seen = HashSet::new();
        let (firsts, copies): (Vec<&StepRecord>, Vec<&StepRecord>) = steps
            .iter()
            .filter(|step| step.action == PlanStepAction::ConvertAvif)
            .partition(|step| {
                step.source_sha256
                    .as_deref()
                    .is_none_or(|sha256| seen.insert(sha256))
            });
        for stills in [&firsts, &copies] {
            run_concurrently(
                stills,
                deps.still_concurrency,
                deps.progress,
                |step: &&StepRecord| run(step),
            )?;
        }
        for step in steps
            .iter()
            .filter(|step| step.action != PlanStepAction::ConvertAvif)
        {
            deps.progress.checkpoint()?;
            run(step)?;
        }
        Ok(())
    })();

    match outcome {
        Ok(()) => {
            settle_plan(deps.catalog, plan_id, false)?;
            Ok(ApplyResult {
                stale_steps: stale.load(Ordering::Acquire),
            })
        }
        Err(error) => {
            settle_plan(deps.catalog, plan_id, deps.stopped())?;
            Err(error)
        }
    }
}

/// Reverses a plan's finished steps, newest first: held files come back, moved files move back,
/// a converted file goes to holding and its original returns. A step whose result changed since
/// is left alone and noted. A step whose file another program has open is left to undo again:
/// the plan stays undoable, and this fails once the rest are back.
pub(crate) fn undo_plan(deps: &ExecutorDeps<'_>, plan_id: PlanId) -> anyhow::Result<()> {
    let steps = deps
        .catalog
        .blocking(move |connection| load_steps(connection, plan_id, StepStatus::Done, true))?;
    let batch = holding_batch_name(Some(plan_id), SystemTime::now());
    let mut in_use: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    deps.progress.phase("Undoing", steps.len() as u64);

    for (index, step) in steps.iter().enumerate() {
        deps.progress.checkpoint()?;
        let id = step.id;
        let undone = || {
            deps.catalog.blocking(move |connection| {
                connection.execute(
                    "UPDATE plan_steps SET status = 'undone', undone_at = ?1,
                       message = CASE WHEN message LIKE 'Undo failed%' THEN NULL ELSE message END
                     WHERE id = ?2",
                    params![now_ms(), id],
                )?;
                Ok(())
            })
        };
        match undo_step(deps, step, &batch) {
            Ok(()) => undone()?,
            Err(error) if error.is::<Cancelled>() => return Err(error),
            // The owner has put it back already, which is what this would have done.
            Err(_) if already_restored(deps, step)? => undone()?,
            Err(error) if is_file_in_use(&error) => {
                in_use.push(base_name(step.to_abs.as_deref().unwrap_or(&step.from_rel)).to_owned());
            }
            Err(error) => {
                failed.push(base_name(step.to_abs.as_deref().unwrap_or(&step.from_rel)).to_owned());
                let message = format!("Undo failed: {error:#}");
                deps.catalog.blocking(move |connection| {
                    connection.execute(
                        "UPDATE plan_steps SET message = ?1 WHERE id = ?2",
                        params![message, id],
                    )?;
                    Ok(())
                })?;
            }
        }
        deps.progress.done(index as u64 + 1);
    }

    if let Some(first) = in_use.first() {
        let others = if in_use.len() > 1 {
            format!(" and {} more", in_use.len() - 1)
        } else {
            String::new()
        };
        bail!("Another program has {first}{others} open. Close it, then Undo again.");
    }
    // Steps that could not be undone stay done, and so does the plan: History must not say undone.
    if let Some(first) = failed.first() {
        let others = if failed.len() > 1 {
            format!(" and {} more", failed.len() - 1)
        } else {
            String::new()
        };
        bail!("{first}{others} could not be put back, and stay as they are.");
    }

    deps.catalog.blocking(move |connection| {
        connection.execute(
            "DELETE FROM duplicate_dismissals WHERE plan_id = ?1",
            [plan_id],
        )?;
        connection.execute(
            "UPDATE plans SET status = 'undone' WHERE id = ?1",
            [plan_id],
        )?;
        Ok(())
    })
}

/// Whether a step that held a file cannot be undone only because the owner has restored the file
/// already, which is what its Undo would have done.
fn already_restored(deps: &ExecutorDeps<'_>, step: &StepRecord) -> anyhow::Result<bool> {
    let Some(holding_id) = step
        .holding_id
        .filter(|_| step.action == PlanStepAction::Hold)
    else {
        return Ok(false);
    };
    let record = deps
        .catalog
        .blocking(move |connection| holding_record_by_id(connection, holding_id))?;
    Ok(record.is_some_and(|record| record.state == "restored"))
}

fn undo_step(deps: &ExecutorDeps<'_>, step: &StepRecord, batch: &str) -> anyhow::Result<()> {
    match step.action {
        PlanStepAction::Hold => {
            if let Some(holding_id) = step.holding_id {
                restore_held(deps.store(), holding_id)?;
            }
            Ok(())
        }
        PlanStepAction::Move | PlanStepAction::Rename => {
            let Some(target) = step.to_abs.as_deref() else {
                return Ok(());
            };
            let current = fs::metadata(target)?;
            if current.size() as i64 != step.expected_size {
                bail!("The moved file has changed since.");
            }
            if path_exists(&step.source_path()) {
                bail!("Something now exists at the original path.");
            }
            move_file(Path::new(target), &step.source_path())?;
            if let Some((root_id, rel_path)) = locate(&deps.roots, Path::new(target)) {
                relocate_row(deps, root_id, &rel_path, &step.source_path())?;
            }
            Ok(())
        }
        PlanStepAction::ConvertAvif
        | PlanStepAction::ConvertAnimation
        | PlanStepAction::ConvertVideo => {
            let (Some(target), Some(holding_id)) = (step.to_abs.as_deref(), step.holding_id) else {
                return Ok(());
            };
            // The original must be able to come back before the converted file is held, or the
            // undo would leave the root with neither.
            restorable(deps.store(), holding_id)?;
            if let Ok(output) = fs::metadata(target) {
                if Some(output.size() as i64) != step.bytes_after {
                    bail!("The converted file has changed since.");
                }
                let Some((root_id, rel_path)) = locate(&deps.roots, Path::new(target)) else {
                    bail!("The converted file is outside every root.");
                };
                hold_file(
                    deps.store(),
                    &HoldRequest {
                        root_id,
                        root_path: &step.root_path,
                        rel_path: &rel_path,
                        batch,
                        plan_id: Some(step.plan_id),
                        reason: "Undone conversion",
                    },
                )?;
            }
            restore_held(deps.store(), holding_id)?;
            point_row_at_original(deps, step, Path::new(target))?;
            Ok(())
        }
        PlanStepAction::RemoveFolder => {
            fs::create_dir_all(step.source_path())?;
            let (plan_id, root_id) = (step.plan_id, step.root_id);
            let held: Vec<(HoldingId, String)> = deps.catalog.blocking(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT id, original_rel FROM holding
              WHERE plan_id = ?1 AND root_id = ?2 AND state = 'held'
                AND reason IN (?3, ?4)",
                )?;
                let rows = statement.query_map(
                    params![
                        plan_id,
                        root_id,
                        FOLDER_FILES_REASON,
                        FINDER_SETTINGS_REASON
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            })?;
            for (id, original_rel) in held {
                if dir_of(&original_rel) == step.from_rel {
                    // Finder or Explorer may have written fresh files into the folder already;
                    // those win.
                    if let Err(error) = restore_held(deps.store(), id) {
                        log::info!("Tidy left {original_rel} in holding: {error:#}");
                    }
                }
            }
            Ok(())
        }
    }
}
