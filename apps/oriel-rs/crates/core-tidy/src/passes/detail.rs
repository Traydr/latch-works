//! The detail pass, from glazier-core's `passes/detail-pass.ts`: detail prints for Spot
//! variants, made only for the stills of similar sets, kept apart from `files` so 4 KB rows never
//! slow its scans. A print counts while its file still has the size and mtime it was made from.

use std::collections::HashMap;

use rusqlite::Connection;

use crate::catalog::files::{SqlParams, ids_param};
use crate::catalog::rows::to_absolute_path;
use crate::contract::FileId;
use crate::passes::{
    PassContext, SAME_ROW_SQL, SelectedFile, error_text, for_each_concurrent, per_core,
    same_row_params, still_selected,
};
use crate::similarity::{DETAIL_VERSION, detail_of_still};

/// A print row that still describes its file: this version, made from the bytes there now.
const CURRENT_DETAIL_JOIN: &str = "file_details d ON d.file_id = f.id AND d.version = $version
  AND d.size = f.size AND d.mtime_ms = f.mtime_ms";

/// Makes detail prints for those of `file_ids` that are stills without a current one.
pub fn run_detail_pass(context: &PassContext<'_>, file_ids: &[FileId]) -> anyhow::Result<()> {
    let params = SqlParams::new()
        .with("ids", ids_param(file_ids))
        .with("version", i64::from(DETAIL_VERSION));
    let sql = format!(
        "SELECT f.id, f.root_id, r.path AS root_path, f.rel_path, f.size, f.mtime_ms
      FROM files f JOIN roots r ON r.id = f.root_id
      LEFT JOIN {CURRENT_DETAIL_JOIN}
      WHERE f.id IN (SELECT value FROM json_each($ids)) AND f.fingerprint LIKE 's:%'
        AND d.file_id IS NULL
      ORDER BY f.id"
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
    let Some(vips) = context.media.vips.clone() else {
        return Ok(());
    };

    for_each_concurrent(
        &pending,
        per_core(),
        context.progress,
        "Comparing similar versions",
        |(file, root_path)| {
            let selected = file.clone();
            let current = context
                .catalog
                .blocking(move |connection| still_selected(connection, &selected))?;
            if !current {
                return Ok(());
            }
            // Recorded either way, so a file that fails is not tried again.
            let path = to_absolute_path(root_path, &file.rel_path);
            let (print, error) = match detail_of_still(&vips, &path) {
                Ok(print) => (Some(print), None),
                Err(error) => (None, Some(error_text(&error.to_string()))),
            };
            let params = same_row_params(file)
                .with("version", i64::from(DETAIL_VERSION))
                .with("print", print)
                .with("error", error);
            context.catalog.blocking(move |connection| {
                connection.execute(
                    &format!(
                        "INSERT INTO file_details (file_id, version, size, mtime_ms, print, error)
      SELECT $id, $version, $size, $mtime_ms, $print, $error
        WHERE EXISTS (SELECT 1 FROM files WHERE {SAME_ROW_SQL})
      ON CONFLICT (file_id) DO UPDATE SET version = excluded.version, size = excluded.size,
        mtime_ms = excluded.mtime_ms, print = excluded.print, error = excluded.error"
                    ),
                    &*params.named(),
                )?;
                Ok(())
            })
        },
    )
}

/// The current prints of these files. A file whose print failed maps to `None`; one not printed
/// yet is missing.
pub fn load_details(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<HashMap<FileId, Option<Vec<u8>>>> {
    let params = SqlParams::new()
        .with("ids", ids_param(file_ids))
        .with("version", i64::from(DETAIL_VERSION));
    let mut statement = connection.prepare_cached(&format!(
        "SELECT d.file_id, d.print FROM files f JOIN {CURRENT_DETAIL_JOIN}
      WHERE f.id IN (SELECT value FROM json_each($ids))"
    ))?;
    let rows = statement.query_map(&*params.named(), |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
