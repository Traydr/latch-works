//! The fingerprint pass, from glazier-core's `passes/fingerprint-pass.ts`: a perceptual hash for
//! stills, five frame hashes for videos and animations. It decodes every picture, so it runs as
//! analysis after the scan. Each file is checked against the catalog just before and after.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use oriel_runtime::Cancelled;
use rusqlite::{Connection, OptionalExtension as _};

use crate::catalog::files::SqlParams;
use crate::catalog::rows::{
    FINGERPRINT_VERSION, FINGERPRINTABLE_SQL, kind_column, to_absolute_path,
};
use crate::contract::{FileId, FileKind, RootId};
use crate::passes::{
    PassContext, SAME_ROW_SQL, SelectedFile, error_text, per_core, run_concurrently,
    same_row_params, still_selected,
};
use crate::similarity::{
    Fingerprint, FingerprintError, Hash64, SAMPLE_POSITIONS, animation_frame_times,
    fingerprint_animation, fingerprint_still, video_frame_hash,
};

/// How many files of a root the pass would fingerprint now.
pub fn pending_fingerprints(connection: &Connection, root_id: RootId) -> anyhow::Result<i64> {
    let params = SqlParams::new()
        .with("version", FINGERPRINT_VERSION)
        .with("root", root_id);
    Ok(connection.query_row(
        &format!(
            "SELECT COUNT(*) AS pending FROM files f
        WHERE f.fingerprint_version < $version AND {FINGERPRINTABLE_SQL} AND f.root_id = $root"
        ),
        &*params.named(),
        |row| row.get(0),
    )?)
}

fn fingerprinted_already(connection: &Connection, id: FileId) -> anyhow::Result<bool> {
    let version: Option<i64> = connection
        .query_row(
            "SELECT fingerprint_version AS version FROM files WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(version.unwrap_or(0) >= FINGERPRINT_VERSION)
}

struct Pending {
    file: SelectedFile,
    root_path: String,
    kind: FileKind,
    frames: Option<i64>,
    duration_ms: Option<f64>,
}

pub fn run_fingerprint_pass(context: &PassContext<'_>) -> anyhow::Result<()> {
    let mut params = SqlParams::new().with("version", FINGERPRINT_VERSION);
    let sql = format!(
        "SELECT f.id, f.root_id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms, f.kind,
        f.frames, f.duration_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.fingerprint_version < $version AND {FINGERPRINTABLE_SQL}
        {}
      ORDER BY f.kind, f.id",
        context.root_clause(&mut params)
    );
    let pending: Vec<Pending> = context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok(Pending {
                file: SelectedFile {
                    id: row.get(0)?,
                    root_id: row.get(1)?,
                    rel_path: row.get(3)?,
                    size: row.get(4)?,
                    mtime_ms: row.get(5)?,
                },
                root_path: row.get(2)?,
                kind: kind_column(row, 6)?,
                frames: row.get(7)?,
                duration_ms: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })?;

    let progress = context.progress;
    progress.phase("Fingerprinting pictures and videos", pending.len() as u64);
    let done = AtomicU64::new(0);
    let count_done = || progress.done(done.fetch_add(1, Ordering::AcqRel) + 1);

    // The query puts pictures first. A still is one libvips decode on one thread, so one still
    // per core.
    let videos_from = pending.partition_point(|pending| pending.kind == FileKind::Image);
    let (pictures, videos) = pending.split_at(videos_from);
    run_concurrently(pictures, per_core(), progress, |pending| {
        if is_current(context, &pending.file)?
            && let Some(made) = fingerprint_picture(context, pending)
        {
            record_print(context, &pending.file, made)?;
        }
        count_done();
        Ok(())
    })?;

    // A video's five frames are five ffmpeg runs of one thread each, taken one per core like
    // stills, so the cores stay busy and a pause or a step aside waits for one frame, never a
    // whole video in turn. The video is recorded once its last frame is in.
    let ffmpeg = context.media.ffmpeg.as_deref();
    let slots: Vec<VideoSlot<'_>> = videos
        .iter()
        .filter_map(|pending| match (ffmpeg, pending.duration_ms) {
            (Some(_), Some(duration_ms)) => Some(VideoSlot::new(pending, duration_ms)),
            // Left for a later analysis, as without ffmpeg or a duration there is no frame.
            _ => {
                count_done();
                None
            }
        })
        .collect();
    let (Some(ffmpeg), false) = (ffmpeg, slots.is_empty()) else {
        return Ok(());
    };
    let frames: Vec<(&VideoSlot<'_>, usize)> = slots
        .iter()
        .flat_map(|slot| (0..SAMPLE_POSITIONS.len()).map(move |position| (slot, position)))
        .collect();
    run_concurrently(&frames, per_core(), progress, |&(slot, position)| {
        let current = slot.is_current(context)?;
        if current {
            let path = to_absolute_path(&slot.pending.root_path, &slot.pending.file.rel_path);
            let seconds = slot.duration_ms * SAMPLE_POSITIONS[position] / 1000.0;
            let frame = video_frame_hash(ffmpeg, &path, seconds, progress.cancel_token());
            if matches!(frame, Err(FingerprintError::Cancelled)) {
                return Err(Cancelled.into());
            }
            slot.frame_in(position, frame);
        }
        if slot.last_frame_done() {
            if current {
                record_print(context, &slot.pending.file, slot.print())?;
            }
            count_done();
        }
        Ok(())
    })
}

/// A video whose frames the pass decodes one per lane.
struct VideoSlot<'a> {
    pending: &'a Pending,
    duration_ms: f64,
    /// Whether the catalog still has the file as selected, without a print: asked once, by
    /// whichever of its frames starts first.
    current: OnceLock<Result<bool, String>>,
    frames: Mutex<Vec<Option<Result<Hash64, FingerprintError>>>>,
    /// Frames not finished yet.
    left: AtomicUsize,
}

impl<'a> VideoSlot<'a> {
    fn new(pending: &'a Pending, duration_ms: f64) -> Self {
        Self {
            pending,
            duration_ms,
            current: OnceLock::new(),
            frames: Mutex::new(vec![None; SAMPLE_POSITIONS.len()]),
            left: AtomicUsize::new(SAMPLE_POSITIONS.len()),
        }
    }

    fn is_current(&self, context: &PassContext<'_>) -> anyhow::Result<bool> {
        self.current
            .get_or_init(|| {
                is_current(context, &self.pending.file).map_err(|error| format!("{error:#}"))
            })
            .clone()
            .map_err(|message| anyhow::anyhow!(message))
    }

    fn frame_in(&self, position: usize, frame: Result<Hash64, FingerprintError>) {
        self.frames.lock().unwrap_or_else(PoisonError::into_inner)[position] = Some(frame);
    }

    /// Counts a frame finished; true for the video's last.
    fn last_frame_done(&self) -> bool {
        self.left.fetch_sub(1, Ordering::AcqRel) == 1
    }

    /// The print the five frames make, or the error of the first position that failed, as one
    /// run after another would have stopped there.
    fn print(&self) -> Result<Fingerprint, FingerprintError> {
        let mut frames = self.frames.lock().unwrap_or_else(PoisonError::into_inner);
        let frames = frames
            .drain(..)
            .map(|frame| frame.unwrap_or(Err(FingerprintError::Cancelled)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Fingerprint::Motion {
            duration_ms: self.duration_ms,
            frames,
        })
    }
}

/// Whether the catalog still has the file as the pass selected it, without a print yet.
fn is_current(context: &PassContext<'_>, file: &SelectedFile) -> anyhow::Result<bool> {
    let selected = file.clone();
    context.catalog.blocking(move |connection| {
        Ok(still_selected(connection, &selected)?
            && !fingerprinted_already(connection, selected.id)?)
    })
}

/// A still's or an animation's print, or why there is none; `None` without libvips, so the file
/// waits for a later analysis.
fn fingerprint_picture(
    context: &PassContext<'_>,
    pending: &Pending,
) -> Option<Result<Fingerprint, FingerprintError>> {
    let vips = context.media.vips.as_deref()?;
    let path = to_absolute_path(&pending.root_path, &pending.file.rel_path);
    Some(if pending.frames.unwrap_or(1) > 1 {
        vips.probe(&path)
            .map_err(FingerprintError::from)
            .and_then(|probe| {
                let times = animation_frame_times(&probe.frame_delays_ms, probe.frames);
                fingerprint_animation(vips, &path, &times)
            })
    } else {
        fingerprint_still(vips, &path)
    })
}

/// Records a file's print, or why there is none, on the row the pass selected.
fn record_print(
    context: &PassContext<'_>,
    file: &SelectedFile,
    made: Result<Fingerprint, FingerprintError>,
) -> anyhow::Result<()> {
    let (print, error) = match made {
        Ok(print) => (Some(print.to_string()), None),
        Err(FingerprintError::Cancelled) => return Err(Cancelled.into()),
        Err(error) => (None, Some(error_text(&error.to_string()))),
    };
    let params = same_row_params(file)
        .with("version", FINGERPRINT_VERSION)
        .with("print", print)
        .with("error", error);
    context.catalog.blocking(move |connection| {
        connection.execute(
            &format!(
                "UPDATE files SET fingerprint_version = $version, fingerprint = $print,
          fingerprint_error = $error WHERE {SAME_ROW_SQL}"
            ),
            &*params.named(),
        )?;
        Ok(())
    })
}
