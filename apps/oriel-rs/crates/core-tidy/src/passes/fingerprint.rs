//! The fingerprint pass, from glazier-core's `passes/fingerprint-pass.ts`: a perceptual hash for
//! stills, five frame hashes for videos and animations. It decodes every picture, so it runs as
//! analysis after the scan. Each file is checked against the catalog just before and after.

use oriel_runtime::Cancelled;
use rusqlite::{Connection, OptionalExtension as _};

use crate::catalog::files::SqlParams;
use crate::catalog::rows::{
    FINGERPRINT_VERSION, FINGERPRINTABLE_SQL, kind_column, to_absolute_path,
};
use crate::contract::{FileId, FileKind, RootId};
use crate::passes::{
    PassContext, SAME_ROW_SQL, SelectedFile, error_text, for_each_concurrent, same_row_params,
    still_selected,
};
use crate::similarity::{
    FingerprintError, animation_frame_times, fingerprint_animation, fingerprint_still,
    fingerprint_video_with,
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

    for_each_concurrent(
        &pending,
        4,
        context.progress,
        "Fingerprinting pictures and videos",
        |pending| {
            let selected = pending.file.clone();
            let current = context.catalog.blocking(move |connection| {
                Ok(still_selected(connection, &selected)?
                    && !fingerprinted_already(connection, selected.id)?)
            })?;
            if current {
                fingerprint_file(context, pending)?;
            }
            Ok(())
        },
    )
}

/// Fingerprints one file and records the print, or why there is none.
fn fingerprint_file(context: &PassContext<'_>, pending: &Pending) -> anyhow::Result<()> {
    let path = to_absolute_path(&pending.root_path, &pending.file.rel_path);
    let made = match pending.kind {
        FileKind::Image => {
            let Some(vips) = &context.media.vips else {
                return Ok(());
            };
            if pending.frames.unwrap_or(1) > 1 {
                vips.probe(&path)
                    .map_err(FingerprintError::from)
                    .and_then(|probe| {
                        let times = animation_frame_times(&probe.frame_delays_ms, probe.frames);
                        fingerprint_animation(vips, &path, &times)
                    })
            } else {
                fingerprint_still(vips, &path)
            }
        }
        _ => {
            let (Some(ffmpeg), Some(duration_ms)) = (&context.media.ffmpeg, pending.duration_ms)
            else {
                return Ok(());
            };
            fingerprint_video_with(ffmpeg, &path, duration_ms, context.progress.cancel_token())
        }
    };
    let (print, error) = match made {
        Ok(print) => (Some(print.to_string()), None),
        Err(FingerprintError::Cancelled) => return Err(Cancelled.into()),
        Err(error) => (None, Some(error_text(&error.to_string()))),
    };
    let params = same_row_params(&pending.file)
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
