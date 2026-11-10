//! The tables beside `files` that the Spot-variants analysis keeps: each still's detail print
//! (`file_details`) and each closer look's answer (`file_comparisons`), counted only while their
//! files have the size and mtime they were made from.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use super::files::{SAME_ROW_SQL, SelectedFile, error_text, same_row_params};
use super::files::{SqlParams, ids_param};
use crate::contract::{FileId, RootId};
use crate::similarity::DETAIL_VERSION;

/// A print row that still describes its file: this version, made from the bytes there now.
pub(crate) const CURRENT_DETAIL_JOIN: &str =
    "file_details d ON d.file_id = f.id AND d.version = $version
  AND d.size = f.size AND d.mtime_ms = f.mtime_ms";

/// What a still's print row says when libvips would not load, which is a final answer for now, so
/// that its set is not held forever, and is taken back once libvips loads.
pub(crate) const NO_DECODER: &str = "libvips did not load";

/// A closer look's answer, stored in `file_comparisons.variant` as 0, 1 and 2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloserLook {
    Copies,
    Different,
    /// A file gone or damaged: both files stay, as for different pictures, but the next analysis
    /// asks again.
    Unreadable,
}

impl CloserLook {
    fn stored(self) -> i64 {
        match self {
            Self::Copies => 0,
            Self::Different => 1,
            Self::Unreadable => UNREADABLE,
        }
    }
}

const UNREADABLE: i64 = 2;

/// A pair's answer, with the size and mtime of each file it was made from.
pub(crate) struct Compared {
    pub left: (FileId, i64, f64),
    pub right: (FileId, i64, f64),
    pub answer: CloserLook,
}

/// Forgets the answers given only because something could not be read, and with libvips back the
/// prints it could not make, so the analysis works out what to do with them as new.
pub(crate) fn forget_unread(connection: &Connection, root_id: RootId) -> anyhow::Result<()> {
    connection.execute("DELETE FROM file_details WHERE error = ?1", [NO_DECODER])?;
    connection.execute(
        "DELETE FROM file_comparisons WHERE variant = ?1
          AND left_id IN (SELECT id FROM files WHERE root_id = ?2)",
        params![UNREADABLE, root_id],
    )?;
    Ok(())
}

/// Whether any pair under a root has an answer only because it could not be read.
pub(crate) fn answers_wait_to_be_read(
    connection: &Connection,
    root_id: RootId,
) -> anyhow::Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM file_comparisons WHERE variant = ?1
          AND left_id IN (SELECT id FROM files WHERE root_id = ?2))",
        params![UNREADABLE, root_id],
        |row| row.get(0),
    )?)
}

/// Whether prints wait to be made again because libvips would not load when they were asked for.
pub(crate) fn prints_wait_for_libvips(connection: &Connection) -> anyhow::Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM file_details WHERE error = ?1)",
        [NO_DECODER],
        |row| row.get(0),
    )?)
}

/// Stores a still's print, or why there is none, for the row the pass selected while it is
/// unchanged and still has a fingerprint.
pub(crate) fn record_detail(
    connection: &Connection,
    file: &SelectedFile,
    print: Option<Vec<u8>>,
    error: Option<String>,
) -> anyhow::Result<()> {
    let params = same_row_params(file)
        .with("version", i64::from(DETAIL_VERSION))
        .with("print", print)
        .with("error", error.as_deref().map(error_text));
    connection.execute(
        &format!(
            "INSERT INTO file_details (file_id, version, size, mtime_ms, print, error)
      SELECT $id, $version, $size, $mtime_ms, $print, $error
        WHERE EXISTS (SELECT 1 FROM files WHERE {SAME_ROW_SQL} AND fingerprint IS NOT NULL)
      ON CONFLICT (file_id) DO UPDATE SET version = excluded.version, size = excluded.size,
        mtime_ms = excluded.mtime_ms, print = excluded.print, error = excluded.error"
        ),
        &*params.named(),
    )?;
    Ok(())
}

/// Stores closer looks, each only while both files are as they were read and still printed.
pub(crate) fn record_comparisons(
    connection: &Connection,
    answers: &[Compared],
) -> anyhow::Result<()> {
    let mut insert = connection.prepare_cached(
        "INSERT OR REPLACE INTO file_comparisons (left_id, right_id, version, left_size,
           left_mtime_ms, right_size, right_mtime_ms, variant)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM files l, files r
           WHERE l.id = ?1 AND l.size = ?4 AND l.mtime_ms = ?5
             AND l.fingerprint IS NOT NULL
             AND r.id = ?2 AND r.size = ?6 AND r.mtime_ms = ?7
             AND r.fingerprint IS NOT NULL",
    )?;
    for compared in answers {
        let (left, right) = (compared.left, compared.right);
        insert.execute(params![
            left.0,
            right.0,
            DETAIL_VERSION,
            left.1,
            left.2,
            right.1,
            right.2,
            compared.answer.stored()
        ])?;
    }
    Ok(())
}

/// Forgets a file's prints and closer looks, whose bytes are no longer the ones they describe.
pub(crate) fn forget_details_of(connection: &Connection, file_id: FileId) -> anyhow::Result<()> {
    connection.execute("DELETE FROM file_details WHERE file_id = ?1", [file_id])?;
    connection.execute(
        "DELETE FROM file_comparisons WHERE left_id = ?1 OR right_id = ?1",
        [file_id],
    )?;
    Ok(())
}

/// Forgets a root's prints and comparisons from before the current version, which cannot be
/// compared with new ones.
pub(crate) fn forget_outdated_details(
    connection: &Connection,
    root_id: RootId,
) -> anyhow::Result<()> {
    connection.execute(
        "DELETE FROM file_details WHERE version != ?1
          AND file_id IN (SELECT id FROM files WHERE root_id = ?2)",
        params![DETAIL_VERSION, root_id],
    )?;
    connection.execute(
        "DELETE FROM file_comparisons WHERE version != ?1
          AND left_id IN (SELECT id FROM files WHERE root_id = ?2)",
        params![DETAIL_VERSION, root_id],
    )?;
    Ok(())
}

/// The current prints of these files. A file whose print failed maps to `None`; one not printed
/// yet is missing.
pub(crate) fn load_details(
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

/// What a closer look found, by the pair's ids, smaller first. A pair is missing until it has one,
/// and when either file has changed since.
pub(crate) type Comparisons = HashMap<(FileId, FileId), bool>;

/// Whether a closer look could read each pair, by ids, smaller first.
pub(crate) type Readings = HashMap<(FileId, FileId), bool>;

/// The current comparisons among these files: whether each pair is of different pictures.
pub(crate) fn load_comparisons(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<Comparisons> {
    Ok(load_answers(connection, file_ids)?
        .into_iter()
        .map(|(pair, variant)| (pair, variant != 0))
        .collect())
}

/// The pairs among these files a closer look has been at: whether it could read them.
pub(crate) fn load_readings(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<Readings> {
    Ok(load_answers(connection, file_ids)?
        .into_iter()
        .map(|(pair, variant)| (pair, variant != UNREADABLE))
        .collect())
}

fn load_answers(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<HashMap<(FileId, FileId), i64>> {
    let params = SqlParams::new()
        .with("ids", ids_param(file_ids))
        .with("version", i64::from(DETAIL_VERSION));
    let mut statement = connection.prepare_cached(
        "SELECT c.left_id, c.right_id, c.variant FROM file_comparisons c
      JOIN files l ON l.id = c.left_id AND l.size = c.left_size AND l.mtime_ms = c.left_mtime_ms
      JOIN files r ON r.id = c.right_id AND r.size = c.right_size AND r.mtime_ms = c.right_mtime_ms
      WHERE c.version = $version AND c.left_id IN (SELECT value FROM json_each($ids))",
    )?;
    let rows = statement.query_map(&*params.named(), |row| {
        Ok(((row.get(0)?, row.get(1)?), row.get(2)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
