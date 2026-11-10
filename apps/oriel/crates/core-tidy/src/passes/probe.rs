//! The probe pass: dimensions, frame counts, codecs,
//! duration and audio tracks for every media file not probed yet. A file that fails records why,
//! which is what the "won't decode" finding lists.

use oriel_runtime::Cancelled;

use crate::catalog::files::{
    SqlParams, StillProbe, record_probe_error, record_still_probe, record_video_probe,
};
use crate::catalog::rows::to_absolute_path;
use crate::contract::{FileId, FileKind};
use crate::passes::{PassContext, for_each_concurrent};
use crate::similarity::animation_frame_times;
use oriel_tools::{ToolError, probe_video};

/// Bumped when the probe reads more, so old rows are probed again.
pub const PROBE_VERSION: i64 = 1;

/// Formats sharp's prebuilt libvips cannot decode, so they are reported rather than probed.
const UNDECODABLE_IMAGE_FORMATS: &str = "'heic', 'psd', 'svg'";

struct Pending {
    id: FileId,
    root_path: String,
    rel_path: String,
    kind: FileKind,
}

/// What a probe found, or why it found nothing.
enum Outcome {
    Image(StillProbe),
    Video(oriel_tools::VideoProbe),
    Failed(String),
    /// The tool the file needs is not here, or was stopped from outside the app; the file waits
    /// for a later scan.
    Skipped,
}

pub fn run_probe_pass(context: &PassContext<'_>) -> anyhow::Result<()> {
    let mut params = SqlParams::new().with("version", PROBE_VERSION);
    let sql = format!(
        "SELECT f.id, r.path AS root_path, f.rel_path, f.kind
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.probe_version < $version AND f.is_junk = 0 AND f.size > 0
        AND (f.kind = 'image' AND COALESCE(f.format, '') NOT IN ({UNDECODABLE_IMAGE_FORMATS})
          OR f.kind = 'video')
        {}",
        context.root_clause(&mut params)
    );
    let pending: Vec<Pending> = context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok(Pending {
                id: row.get(0)?,
                root_path: row.get(1)?,
                rel_path: row.get(2)?,
                kind: crate::catalog::rows::kind_column(row, 3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })?;

    // libvips reads headers no faster past about 3 at once (its loader search takes shared
    // locks): 18 at once took 2.4 times the CPU of 6, in the same time.
    for_each_concurrent(
        &pending,
        6,
        context.progress,
        "Reading media details",
        |file| {
            let outcome = probe(context, file)?;
            write(context, file.id, outcome)
        },
    )
}

fn probe(context: &PassContext<'_>, file: &Pending) -> anyhow::Result<Outcome> {
    let path = to_absolute_path(&file.root_path, &file.rel_path);
    if file.kind == FileKind::Image {
        let Some(vips) = context.media.loaded_vips() else {
            return Ok(Outcome::Skipped);
        };
        return Ok(match vips.probe(&path) {
            Ok(probe) => {
                let times = animation_frame_times(&probe.frame_delays_ms, probe.frames);
                Outcome::Image(StillProbe {
                    width: i64::from(probe.width),
                    height: i64::from(probe.height),
                    frames: i64::from(probe.frames),
                    has_alpha: probe.has_alpha,
                    duration_ms: (probe.frames > 1)
                        .then(|| times.iter().map(|&time| f64::from(time)).sum()),
                })
            }
            Err(error) => Outcome::Failed(error.to_string()),
        });
    }
    let Some(ffprobe) = &context.media.ffprobe else {
        return Ok(Outcome::Skipped);
    };
    match probe_video(ffprobe, &path, context.progress.cancel_token()) {
        Ok(probe) => Ok(Outcome::Video(probe)),
        Err(ToolError::Cancelled) => Err(Cancelled.into()),
        Err(ToolError::Killed) => Ok(Outcome::Skipped),
        Err(error) => Ok(Outcome::Failed(error.to_string())),
    }
}

fn write(context: &PassContext<'_>, id: FileId, outcome: Outcome) -> anyhow::Result<()> {
    context.catalog.blocking(move |connection| match outcome {
        Outcome::Image(probe) => record_still_probe(connection, id, PROBE_VERSION, &probe),
        Outcome::Video(probe) => record_video_probe(connection, id, PROBE_VERSION, &probe),
        Outcome::Failed(message) => record_probe_error(connection, id, PROBE_VERSION, &message),
        Outcome::Skipped => Ok(()),
    })
}
