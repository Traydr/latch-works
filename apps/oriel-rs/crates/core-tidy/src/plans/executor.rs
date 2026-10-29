//! The executor, from glazier-core's `plans/executor.ts`: it applies a reviewed plan step by step
//! and undoes one, newest step first.
//!
//! This is the code that moves the owner's files, so it keeps glazier-core's guarantees exactly:
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
//! The engine runs it on a worker thread; catalog calls go to the catalog's thread one by one.

use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Instant, SystemTime};

use anyhow::{Context as _, anyhow, bail};
use oriel_avif::Libavif;
use oriel_core_format::{AudioTrackPlan, VideoTrackPlan};
use oriel_runtime::Cancelled;
use rusqlite::{OptionalExtension as _, params};

use super::holding::{
    HoldRequest, HoldingPlaces, HoldingStore, copy_times, hold_file, holding_batch_name, move_file,
    path_exists, restore_held,
};
use super::journal::{StepRecord, load_steps, plan_subject, temp_path_of};
use super::planner::{StepSpec, is_within};
use crate::catalog::rows::{PROBE_VERSION, to_absolute_path};
use crate::catalog::{Catalog, now_ms};
use crate::contract::{
    FileFormat, HoldingId, PlanId, PlanKind, PlanStepAction, Root, RootId, StepStatus,
};
use crate::media::still::encode_still_to_avif;
use crate::media::transcode::{TranscodeJob, transcode_with_ffmpeg};
use crate::media::{ToolFailure, probe_video};
use crate::number::format_bytes;
use crate::passes::hash::{HashError, hash_whole_file};
use crate::passes::{Media, Progress};
use crate::scan::{extension_of, is_extension_mismatch, is_folder_system_file, whole_ms};

/// A conversion is kept only when it saves at least this share of the original's bytes.
const MINIMUM_SAVING: f64 = 0.05;

/// Holding's reason for a `.DS_Store` or `Thumbs.db` that left with the empty folder it was in.
const FOLDER_FILES_REASON: &str = "Left by Finder or Explorer in an empty folder";

/// The same reason as glazier-core 0.1.2 to 0.1.4 wrote it, when only `.DS_Store` left with its
/// folder; an undo still brings those back.
const FINDER_SETTINGS_REASON: &str = "Finder's settings for an empty folder";

const CHANGED_SINCE_SCAN: &str = "The file changed since the scan; rescan before changing it.";

/// How the plan kinds that keep only a smaller result remember a file that did not shrink, so
/// they stop offering it: Convert and Shrink each keep their own mark.
fn not_smaller_sql(kind: Option<PlanKind>) -> Option<&'static str> {
    match kind? {
        PlanKind::Optimize => {
            Some("UPDATE files SET optimize_not_smaller = 1 WHERE root_id = ?1 AND rel_path = ?2")
        }
        PlanKind::ShrinkVideos => {
            Some("UPDATE files SET shrink_not_smaller = 1 WHERE root_id = ?1 AND rel_path = ?2")
        }
        _ => None,
    }
}

/// What the executor works with.
pub struct ExecutorDeps<'a> {
    pub catalog: &'a Catalog,
    /// Where each root's held files go.
    pub places: &'a HoldingPlaces,
    pub media: &'a Media,
    /// The AVIF encoder, or why there is none.
    pub libavif: Result<&'a Libavif, String>,
    /// ffmpeg has SVT-AV1, which every AV1 encode uses.
    pub svt_av1: bool,
    /// AVIF encodes run this many at once.
    pub still_concurrency: usize,
    pub roots: Vec<Root>,
    pub progress: &'a dyn Progress,
}

impl ExecutorDeps<'_> {
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
    },
    Skipped(String),
    Failed(String),
}

/// A step left alone, with why; `stale` when the catalog is out of date for its file, so a scan
/// has to catch it up before it can be tried again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepSkip {
    pub message: String,
    pub stale: bool,
}

impl StepSkip {
    fn stale(message: &str) -> anyhow::Error {
        anyhow::Error::new(Self {
            message: message.to_owned(),
            stale: true,
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
                || (cfg!(windows)
                    && (error.kind() == io::ErrorKind::PermissionDenied
                        || matches!(error.raw_os_error(), Some(32 | 33))))
        })
    })
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', std::path::MAIN_SEPARATOR])
        .next()
        .unwrap_or(path)
}

fn dir_of(rel_path: &str) -> &str {
    rel_path.rfind('/').map_or("", |index| &rel_path[..index])
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

fn whole_mtime(metadata: &fs::Metadata) -> i64 {
    whole_ms(metadata.mtime(), metadata.mtime_nsec())
}

fn whole_ctime(metadata: &fs::Metadata) -> i64 {
    whole_ms(metadata.ctime(), metadata.ctime_nsec())
}

/// Re-reads the source just before touching it. A file that changed since the scan (size, mtime
/// or ctime) or vanished is skipped. When only the ctime moved, as when a sync client tags a file
/// it sees arrive, the bytes decide: a file that still hashes to the catalog's SHA-256 is the
/// file the plan was drafted for.
fn check_source(deps: &ExecutorDeps<'_>, step: &StepRecord) -> anyhow::Result<fs::Metadata> {
    let source = step.from_abs();
    let Ok(current) = fs::symlink_metadata(&source) else {
        return Err(StepSkip::stale("The file is no longer there."));
    };
    if !current.is_file()
        || current.size() as i64 != step.expected_size
        || whole_mtime(&current) != step.expected_mtime_ms.trunc() as i64
    {
        return Err(StepSkip::stale(CHANGED_SINCE_SCAN));
    }
    if whole_ctime(&current) != step.expected_ctime_ms.trunc() as i64
        && !holds_catalogued_bytes(deps, step, &current)?
    {
        return Err(StepSkip::stale(CHANGED_SINCE_SCAN));
    }
    Ok(fs::symlink_metadata(&source)?)
}

/// Whether the file still hashes to the SHA-256 the catalog has for it; false without one.
fn holds_catalogued_bytes(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    current: &fs::Metadata,
) -> anyhow::Result<bool> {
    let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
    let catalogued: Option<String> = deps.catalog.blocking(move |connection| {
        Ok(connection
            .query_row(
                "SELECT sha256 FROM files WHERE root_id = ?1 AND rel_path = ?2",
                params![root_id, rel_path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })?;
    let Some(catalogued) = catalogued else {
        return Ok(false);
    };
    let expected = (
        current.size() as i64,
        whole_mtime(current) as f64,
        whole_ctime(current) as f64,
    );
    match hash_whole_file(&step.from_abs(), expected, deps.progress) {
        Ok(sha256) => Ok(sha256 == catalogued),
        Err(HashError::Cancelled) => Err(Cancelled.into()),
        Err(HashError::Unreadable) => Ok(false),
    }
}

/// Points a catalog row at a file's new path when the bytes did not change (move, rename). A
/// file moved out of every root leaves the catalog.
fn relocate_row(deps: &ExecutorDeps<'_>, step: &StepRecord, target: &Path) -> anyhow::Result<()> {
    let (root_id, from) = (step.root_id, step.from_rel.clone());
    let Some((new_root, rel_path)) = locate(&deps.roots, target) else {
        return deps.catalog.blocking(move |connection| {
            connection.execute(
                "DELETE FROM files WHERE root_id = ?1 AND rel_path = ?2",
                params![root_id, from],
            )?;
            Ok(())
        });
    };
    let moved = fs::metadata(target)?;
    let name = base_name(&rel_path).to_owned();
    let ext = extension_of(&name);
    let dir = dir_of(&rel_path).to_owned();
    let (ctime, dev, ino) = (
        whole_ctime(&moved),
        moved.dev().to_string(),
        moved.ino().to_string(),
    );
    deps.catalog.blocking(move |connection| {
        let format: Option<String> = connection
            .query_row(
                "SELECT format FROM files WHERE root_id = ?1 AND rel_path = ?2",
                params![root_id, from],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let mismatch = format
            .as_deref()
            .and_then(FileFormat::parse)
            .is_some_and(|format| is_extension_mismatch(format, &ext));
        connection.execute(
            "UPDATE files SET root_id = ?1, rel_path = ?2, dir = ?3, name = ?4, ext = ?5,
          ctime_ms = ?6, dev = ?7, ino = ?8,
          ext_mismatch = CASE WHEN format IS NULL THEN 0 ELSE ?9 END
          WHERE root_id = ?10 AND rel_path = ?11",
            params![
                new_root,
                rel_path,
                dir,
                name,
                ext,
                ctime,
                dev,
                ino,
                i64::from(mismatch),
                root_id,
                from
            ],
        )?;
        Ok(())
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

/// Rewrites a catalog row for a converted file: new path, new bytes, the facts just checked. A
/// conversion that copied the audio track keeps the track's loudness measurement.
fn replace_row(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    target: &Path,
    facts: OutputFacts,
    keep_loudness: bool,
) -> anyhow::Result<()> {
    let Some((_, rel_path)) = locate(&deps.roots, target) else {
        return Ok(());
    };
    let written = fs::metadata(target)?;
    let name = base_name(&rel_path).to_owned();
    let row = (
        dir_of(&rel_path).to_owned(),
        extension_of(&name),
        written.size() as i64,
        whole_mtime(&written),
        whole_ctime(&written),
        written.dev().to_string(),
        written.ino().to_string(),
    );
    let (root_id, from) = (step.root_id, step.from_rel.clone());
    deps.catalog.blocking(move |connection| {
        connection.execute(
            "UPDATE files SET rel_path = ?1, dir = ?2, name = ?3, ext = ?4, size = ?5,
          mtime_ms = ?6, ctime_ms = ?7, dev = ?8, ino = ?9, kind = ?10, format = ?11,
          ext_mismatch = 0, probe_version = ?12, probe_error = NULL, width = ?13,
          height = ?14, frames = ?15, duration_ms = ?16, video_codec = ?17,
          audio_codec = ?18, audio_streams = ?19, bitrate = ?20, head_hash = NULL,
          sha256 = NULL, fingerprint_version = 0, fingerprint = NULL, fingerprint_error = NULL,
          loudness_version = CASE WHEN ?21 = 1 THEN loudness_version ELSE 0 END,
          loudness_max_db = CASE WHEN ?21 = 1 THEN loudness_max_db ELSE NULL END,
          optimize_not_smaller = 0, shrink_not_smaller = 0
          WHERE root_id = ?22 AND rel_path = ?23",
            params![
                rel_path,
                row.0,
                name,
                row.1,
                row.2,
                row.3,
                row.4,
                row.5,
                row.6,
                facts.kind,
                facts.format.as_str(),
                PROBE_VERSION,
                facts.width,
                facts.height,
                facts.frames,
                facts.duration_ms,
                facts.video_codec,
                facts.audio_codec,
                facts.audio_streams,
                facts.bitrate,
                i64::from(keep_loudness),
                root_id,
                from
            ],
        )?;
        Ok(())
    })
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
    let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
    deps.catalog.blocking(move |connection| {
        Ok(connection
            .query_row(
                "SELECT width, height, duration_ms, audio_streams FROM files
          WHERE root_id = ?1 AND rel_path = ?2",
                params![root_id, rel_path],
                |row| {
                    Ok(SourceFacts {
                        width: row.get(0)?,
                        height: row.get(1)?,
                        duration_ms: row.get(2)?,
                        audio_streams: row.get(3)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    })
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
    not_smaller: Option<&'static str>,
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

/// Writes a conversion to a temp file, checks it with `verify`, gives it the original's dates,
/// puts it in place and moves the original to holding. When the target is the original's own
/// path (re-encoding an MP4), the original leaves first.
fn convert(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    context: ConvertContext<'_>,
    produce: impl FnOnce(&Path) -> anyhow::Result<Option<String>>,
    verify: impl FnOnce(&Path) -> anyhow::Result<OutputFacts>,
) -> anyhow::Result<StepOutcome> {
    let Some(target) = step.to_abs.as_deref().map(PathBuf::from) else {
        return Ok(StepOutcome::Failed("The step has no target.".into()));
    };
    let source = step.from_abs();
    let same_path = std::path::absolute(&target)? == std::path::absolute(&source)?;
    if !same_path && path_exists(&target) {
        return Ok(StepOutcome::Skipped(format!(
            "{} already exists.",
            base_name(&target.to_string_lossy())
        )));
    }
    let temp = TempFile(PathBuf::from(temp_path_of(&target.to_string_lossy())));

    let note = produce(&temp.0)?;
    let facts = verify(&temp.0)?;
    let written = fs::metadata(&temp.0)?.size();
    let original = context.source.size();

    if context.require_smaller && written as f64 > original as f64 * (1.0 - MINIMUM_SAVING) {
        fs::remove_file(&temp.0)?;
        if let Some(sql) = context.not_smaller {
            let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
            deps.catalog.blocking(move |connection| {
                connection.execute(sql, params![root_id, rel_path])?;
                Ok(())
            })?;
        }
        let why = if written > original {
            "the result was larger"
        } else {
            "it saved less than 5%"
        };
        return Ok(StepOutcome::Skipped(format!(
            "Kept the original: {why} ({} → {})",
            format_bytes(original as f64),
            format_bytes(written as f64)
        )));
    }

    copy_times(&temp.0, context.source)?;

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
            restore_held(deps.catalog, holding_id)?;
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
                if path_exists(&source) {
                    let _ = fs::remove_file(&target);
                }
                return Err(error);
            }
        }
    };

    replace_row(deps, step, &target, facts, context.keep_loudness)?;
    Ok(StepOutcome::Done {
        bytes_after: written as i64,
        holding_id: Some(holding_id),
        message: note,
    })
}

fn tool_error(failure: ToolFailure) -> anyhow::Error {
    match failure {
        ToolFailure::Cancelled => Cancelled.into(),
        ToolFailure::Failed(message) => anyhow!(message),
    }
}

fn remove_folder(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    batch: &str,
) -> anyhow::Result<StepOutcome> {
    let folder = step.from_abs();
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
    fs::remove_dir(&folder)?;
    let (root_id, rel_path) = (step.root_id, step.from_rel.clone());
    deps.catalog.blocking(move |connection| {
        connection.execute(
            "DELETE FROM empty_folders WHERE root_id = ?1 AND rel_path = ?2",
            params![root_id, rel_path],
        )?;
        Ok(())
    })?;
    Ok(StepOutcome::Done {
        bytes_after: 0,
        holding_id: None,
        message: None,
    })
}

fn execute_step(
    deps: &ExecutorDeps<'_>,
    step: &StepRecord,
    batch: &str,
    not_smaller: Option<&'static str>,
) -> anyhow::Result<StepOutcome> {
    if step.spec == StepSpec::RemoveFolder {
        return remove_folder(deps, step, batch);
    }
    let source = check_source(deps, step)?;

    match &step.spec {
        StepSpec::RemoveFolder => unreachable!("handled above"),
        StepSpec::Hold { reason } => {
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
            deps.catalog.blocking(move |connection| {
                connection.execute(
                    "DELETE FROM files WHERE root_id = ?1 AND rel_path = ?2",
                    params![root_id, rel_path],
                )?;
                Ok(())
            })?;
            Ok(StepOutcome::Done {
                bytes_after: 0,
                holding_id: Some(holding_id),
                message: None,
            })
        }
        StepSpec::Move | StepSpec::Rename => {
            let Some(target) = step.to_abs.as_deref().map(PathBuf::from) else {
                return Ok(StepOutcome::Failed("The step has no target.".into()));
            };
            if std::path::absolute(&target)? != std::path::absolute(step.from_abs())?
                && path_exists(&target)
            {
                return Ok(StepOutcome::Skipped(format!(
                    "{} already exists there.",
                    base_name(&target.to_string_lossy())
                )));
            }
            move_file(&step.from_abs(), &target)?;
            relocate_row(deps, step, &target)?;
            Ok(StepOutcome::Done {
                bytes_after: source.size() as i64,
                holding_id: None,
                message: None,
            })
        }
        StepSpec::ConvertAvif => {
            let expected = source_facts(deps, step)?;
            let vips = deps
                .media
                .vips
                .as_deref()
                .context("libvips is unavailable, so stills cannot be converted.")?;
            let libavif = deps.libavif.clone().map_err(|error| anyhow!(error))?;
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
                    encode_still_to_avif(vips, libavif, &step.from_abs(), temp)?;
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
            let Some(ffmpeg) = deps.media.ffmpeg.as_deref() else {
                return Ok(StepOutcome::Failed(
                    "ffmpeg is unavailable, so the file cannot be converted.".into(),
                ));
            };
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
            let source_path = step.from_abs();
            let cancel = deps.progress.cancel_token();
            let verify =
                |temp: &Path| verify_video(ffprobe, temp, expected, animation, audio, cancel);
            let context = ConvertContext {
                batch,
                source: &source,
                // An animation is converted only to save space, as Electron Oriel's main path.
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
                    let job = match tracks {
                        Some((video, audio)) => TranscodeJob::Video {
                            src: &source_path,
                            out: temp,
                            video,
                            audio,
                            quality,
                        },
                        None => TranscodeJob::Animation {
                            src: &source_path,
                            out: temp,
                        },
                    };
                    let started = Instant::now();
                    transcode_with_ffmpeg(ffmpeg, &job, cancel).map_err(tool_error)?;
                    if !svt {
                        return Ok(None);
                    }
                    // Timed whether or not the result is kept: the time was spent either way.
                    if let (Some(width), Some(height), Some(duration_ms)) =
                        (expected.width, expected.height, expected.duration_ms)
                    {
                        let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
                        record_encode_timing(
                            deps.catalog,
                            (width * height) as f64,
                            duration_ms,
                            wall_ms,
                        )?;
                    }
                    Ok(Some("Encoded with SVT-AV1".to_owned()))
                },
                verify,
            )
        }
    }
}

/// Encode timings kept; older ones are dropped as new ones come in.
const KEPT_TIMINGS: i64 = 500;

/// Records how long one SVT-AV1 encode took, which Shrink's estimate of encode times learns
/// from. The catalog lives in this machine's data folder, so these are this machine's speeds.
pub fn record_encode_timing(
    catalog: &Catalog,
    pixels: f64,
    media_ms: f64,
    wall_ms: f64,
) -> anyhow::Result<()> {
    catalog.blocking(move |connection| {
        connection.execute(
            "INSERT INTO encode_timings (encoder, pixels, media_ms, wall_ms, at)
        VALUES ('svt-av1', ?1, ?2, ?3, ?4)",
            params![pixels, media_ms, wall_ms, now_ms()],
        )?;
        connection.execute(
            "DELETE FROM encode_timings WHERE id <= (SELECT MAX(id) FROM encode_timings) - ?1",
            [KEPT_TIMINGS],
        )?;
        Ok(())
    })
}

/// Checks a video or animation conversion's result as glazier-core does: a picture, the
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
            } => connection.execute(
                "UPDATE plan_steps SET status = 'done', message = ?1, bytes_after = ?2,
            holding_id = ?3, done_at = ?4 WHERE id = ?5",
                params![message, bytes_after, holding_id, now_ms(), step_id],
            )?,
            StepOutcome::Skipped(message) => connection.execute(
                "UPDATE plan_steps SET status = 'skipped', message = ?1 WHERE id = ?2",
                params![message, step_id],
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
        Ok(())
    })
}

/// What the progress of an apply says while a step of this action runs.
pub fn describe_action(action: PlanStepAction) -> &'static str {
    match action {
        PlanStepAction::Hold => "Moving files to holding",
        PlanStepAction::Move => "Moving files",
        PlanStepAction::Rename => "Renaming files",
        PlanStepAction::ConvertAvif => "Converting stills to AVIF",
        PlanStepAction::ConvertAnimation => "Converting animations to MP4",
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
pub fn apply_plan(deps: &ExecutorDeps<'_>, plan_id: PlanId) -> anyhow::Result<ApplyResult> {
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
    let not_smaller = not_smaller_sql(kind);
    let stale = AtomicUsize::new(0);
    let count = StepCount {
        progress: deps.progress,
        total: steps.len() as u64,
        done: Mutex::new(0),
    };
    deps.progress.phase(
        steps
            .first()
            .map_or("Changing files", |step| describe_action(step.action)),
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
                    StepOutcome::Skipped(skip.message.clone())
                }
                None if is_file_in_use(&error) => StepOutcome::Failed(format!(
                    "Another program has {} open, so it was left as it was.",
                    base_name(&step.from_rel)
                )),
                None => StepOutcome::Failed(format!("{error:#}")),
            },
        };
        record_outcome(deps.catalog, step.id, outcome)?;
        count.finished(describe_action(step.action));
        Ok(())
    };

    let outcome = (|| -> anyhow::Result<()> {
        let stills: Vec<&StepRecord> = steps
            .iter()
            .filter(|step| step.action == PlanStepAction::ConvertAvif)
            .collect();
        run_concurrently(
            &stills,
            deps.still_concurrency,
            deps.progress,
            &|step: &&StepRecord| run(step),
        )?;
        for step in steps
            .iter()
            .filter(|step| step.action != PlanStepAction::ConvertAvif)
        {
            deps.progress.check()?;
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

/// Runs `work` over `items`, at most `concurrency` at a time, stopping between items once the
/// work is stopped or one fails.
fn run_concurrently<T: Sync>(
    items: &[T],
    concurrency: usize,
    progress: &dyn Progress,
    work: &(dyn Fn(&T) -> anyhow::Result<()> + Sync),
) -> anyhow::Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let next = AtomicUsize::new(0);
    let failed = std::sync::atomic::AtomicBool::new(false);
    let lanes = concurrency.clamp(1, items.len());
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..lanes)
            .map(|_| {
                scope.spawn(|| -> anyhow::Result<()> {
                    loop {
                        if failed.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        progress.check()?;
                        let Some(item) = items.get(next.fetch_add(1, Ordering::AcqRel)) else {
                            return Ok(());
                        };
                        if let Err(error) = work(item) {
                            failed.store(true, Ordering::Release);
                            return Err(error);
                        }
                    }
                })
            })
            .collect();
        let mut first = None;
        for handle in handles {
            let outcome = handle
                .join()
                .unwrap_or_else(|_| Err(anyhow!("a conversion worker panicked")));
            if let Err(error) = outcome
                && first.is_none()
            {
                first = Some(error);
            }
        }
        first.map_or(Ok(()), Err)
    })
}

/// Reverses a plan's finished steps, newest first: held files come back, moved files move back,
/// a converted file goes to holding and its original returns. A step whose result changed since
/// is left alone and noted. A step whose file another program has open is left to undo again:
/// the plan stays undoable, and this fails once the rest are back.
pub fn undo_plan(deps: &ExecutorDeps<'_>, plan_id: PlanId) -> anyhow::Result<()> {
    let steps = deps
        .catalog
        .blocking(move |connection| load_steps(connection, plan_id, StepStatus::Done, true))?;
    let batch = holding_batch_name(Some(plan_id), SystemTime::now());
    let mut in_use: Vec<String> = Vec::new();
    deps.progress.phase("Undoing", steps.len() as u64);

    for (index, step) in steps.iter().enumerate() {
        deps.progress.check()?;
        let id = step.id;
        match undo_step(deps, step, &batch) {
            Ok(()) => deps.catalog.blocking(move |connection| {
                connection.execute(
                    "UPDATE plan_steps SET status = 'undone', undone_at = ?1 WHERE id = ?2",
                    params![now_ms(), id],
                )?;
                Ok(())
            })?,
            Err(error) if error.is::<Cancelled>() => return Err(error),
            Err(error) if is_file_in_use(&error) => {
                in_use.push(base_name(step.to_abs.as_deref().unwrap_or(&step.from_rel)).to_owned());
            }
            Err(error) => {
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

fn undo_step(deps: &ExecutorDeps<'_>, step: &StepRecord, batch: &str) -> anyhow::Result<()> {
    match step.action {
        PlanStepAction::Hold => {
            if let Some(holding_id) = step.holding_id {
                restore_held(deps.catalog, holding_id)?;
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
            if path_exists(&step.from_abs()) {
                bail!("Something now exists at the original path.");
            }
            move_file(Path::new(target), &step.from_abs())?;
            Ok(())
        }
        PlanStepAction::ConvertAvif
        | PlanStepAction::ConvertAnimation
        | PlanStepAction::ConvertVideo => {
            let (Some(target), Some(holding_id)) = (step.to_abs.as_deref(), step.holding_id) else {
                return Ok(());
            };
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
            restore_held(deps.catalog, holding_id)?;
            Ok(())
        }
        PlanStepAction::RemoveFolder => {
            fs::create_dir_all(step.from_abs())?;
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
                    let _ = restore_held(deps.catalog, id);
                }
            }
            Ok(())
        }
    }
}

/// The absolute path of a step's source, for callers outside the executor.
pub fn step_source(step: &StepRecord) -> PathBuf {
    to_absolute_path(&step.root_path, &step.from_rel)
}
