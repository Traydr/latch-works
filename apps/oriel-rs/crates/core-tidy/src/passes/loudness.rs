//! The loudness pass, from glazier-core's `passes/loudness-pass.ts`: measures every video with an
//! audio track whose loudness is unknown. A track ffmpeg cannot measure is recorded as tried,
//! without a level, so it stays unmeasured instead of being decoded again after every scan.

use oriel_runtime::Cancelled;
use rusqlite::{Connection, OptionalExtension as _};

use crate::catalog::files::SqlParams;
use crate::catalog::rows::{LOUDNESS_VERSION, to_absolute_path};
use crate::contract::{FileId, RootId};
use crate::media::{ToolFailure, measure_peak_volume};
use crate::passes::{
    PassContext, SAME_ROW_SQL, SelectedFile, for_each_concurrent, per_core, same_row_params,
    still_selected,
};

/// Videos with an audio track the pass has not measured, as a condition on `files f`.
const UNMEASURED_SQL: &str = "f.kind = 'video' AND f.probe_version > 0 \
  AND COALESCE(f.audio_streams, 0) > 0 AND f.loudness_version < $version";

/// How many videos of a root the pass would measure now.
pub fn pending_loudness(connection: &Connection, root_id: RootId) -> anyhow::Result<i64> {
    let params = SqlParams::new()
        .with("version", LOUDNESS_VERSION)
        .with("root", root_id);
    Ok(connection.query_row(
        &format!(
            "SELECT COUNT(*) AS pending FROM files f WHERE {UNMEASURED_SQL} AND f.root_id = $root"
        ),
        &*params.named(),
        |row| row.get(0),
    )?)
}

fn measured_already(connection: &Connection, id: FileId) -> anyhow::Result<bool> {
    let version: Option<i64> = connection
        .query_row(
            "SELECT loudness_version AS version FROM files WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(version.unwrap_or(0) >= LOUDNESS_VERSION)
}

pub fn run_loudness_pass(context: &PassContext<'_>) -> anyhow::Result<()> {
    let Some(ffmpeg) = context.media.ffmpeg.clone() else {
        return Ok(());
    };
    let mut params = SqlParams::new().with("version", LOUDNESS_VERSION);
    let sql = format!(
        "SELECT f.id, f.root_id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE {UNMEASURED_SQL} {}",
        context.root_clause(&mut params)
    );
    let pending: Vec<(SelectedFile, String)> = context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok((
                SelectedFile {
                    id: row.get(0)?,
                    root_id: row.get(1)?,
                    rel_path: row.get(3)?,
                    size: row.get(4)?,
                    mtime_ms: row.get(5)?,
                },
                row.get::<_, String>(2)?,
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })?;

    // ffmpeg decodes a soundtrack on one thread.
    for_each_concurrent(
        &pending,
        per_core(),
        context.progress,
        "Listening for sound",
        |(file, root_path)| {
            let selected = file.clone();
            let current = context.catalog.blocking(move |connection| {
                Ok(still_selected(connection, &selected)?
                    && !measured_already(connection, selected.id)?)
            })?;
            if !current {
                return Ok(());
            }
            let path = to_absolute_path(root_path, &file.rel_path);
            let peak = match measure_peak_volume(&ffmpeg, &path, context.progress.cancel_token()) {
                Ok(peak) => Some(peak),
                Err(ToolFailure::Cancelled) => return Err(Cancelled.into()),
                Err(ToolFailure::Failed(_)) => None,
            };
            let params = same_row_params(file)
                .with("version", LOUDNESS_VERSION)
                .with("peak", peak);
            context.catalog.blocking(move |connection| {
                connection.execute(
                    &format!(
                        "UPDATE files SET loudness_version = $version, loudness_max_db = $peak
          WHERE {SAME_ROW_SQL}"
                    ),
                    &*params.named(),
                )?;
                Ok(())
            })
        },
    )
}
