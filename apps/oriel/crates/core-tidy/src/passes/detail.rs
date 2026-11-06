//! The detail pass, from glazier-core's `passes/detail-pass.ts`: detail prints for Spot
//! variants, made only for the stills of similar sets, kept apart from `files` so 4 KB rows never
//! slow its scans. A print counts while its file still has the size and mtime it was made from.
//!
//! The comparison pass takes a closer look at the pairs those prints call copies and keeps only
//! each pair's answer, since the looks themselves are too large to keep for every still.

use std::collections::HashMap;
use std::path::PathBuf;

use rusqlite::{Connection, params};

use crate::catalog::files::{SqlParams, ids_param};
use crate::catalog::rows::to_absolute_path;
use crate::contract::{FileId, RootId};
use crate::passes::{
    PassContext, SAME_ROW_SQL, SelectedFile, error_text, for_each_concurrent, per_core,
    same_row_params, still_selected,
};
use crate::similarity::{
    DETAIL_VERSION, DisjointSets, StillLook, detail_of_still, look_at_still, look_shows_variant,
};

/// A print row that still describes its file: this version, made from the bytes there now.
const CURRENT_DETAIL_JOIN: &str = "file_details d ON d.file_id = f.id AND d.version = $version
  AND d.size = f.size AND d.mtime_ms = f.mtime_ms";

/// What a still's print row says when libvips would not load, which is a final answer for now, so
/// that its set is not held forever, and is taken back once libvips loads.
const NO_DECODER: &str = "libvips did not load";

/// A closer look's answer: `variant` holds 0 for copies and 1 for different pictures, and this for
/// a pair it could not read, a file gone or damaged. It keeps both files as 1 does, and being
/// non-zero reads as 1 everywhere, but the next analysis asks again.
const COULD_NOT_READ: i64 = 2;

/// Forgets the answers given only because something could not be read, and with libvips back the
/// prints it could not make, so the analysis works out what to do with them as new.
pub fn forget_unread(connection: &Connection, root_id: RootId) -> anyhow::Result<()> {
    connection.execute("DELETE FROM file_details WHERE error = ?1", [NO_DECODER])?;
    connection.execute(
        "DELETE FROM file_comparisons WHERE variant = ?1
          AND left_id IN (SELECT id FROM files WHERE root_id = ?2)",
        params![COULD_NOT_READ, root_id],
    )?;
    Ok(())
}

/// Whether any pair under a root has an answer only because it could not be read.
pub fn answers_wait_to_be_read(connection: &Connection, root_id: RootId) -> anyhow::Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM file_comparisons WHERE variant = ?1
          AND left_id IN (SELECT id FROM files WHERE root_id = ?2))",
        params![COULD_NOT_READ, root_id],
        |row| row.get(0),
    )?)
}

/// Whether prints wait to be made again because libvips would not load when they were asked for.
pub fn prints_wait_for_libvips(connection: &Connection) -> anyhow::Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM file_details WHERE error = ?1)",
        [NO_DECODER],
        |row| row.get(0),
    )?)
}

/// Makes detail prints for those of `file_ids` that are stills without a current one.
pub fn run_detail_pass(context: &PassContext<'_>, file_ids: &[FileId]) -> anyhow::Result<()> {
    let vips = context.media.loaded_vips();
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
            let (print, error) = match vips.map(|vips| detail_of_still(vips, &path)) {
                Some(Ok(print)) => (Some(print), None),
                Some(Err(error)) => (None, Some(error_text(&error.to_string()))),
                None => (None, Some(NO_DECODER.to_owned())),
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
        WHERE EXISTS (SELECT 1 FROM files WHERE {SAME_ROW_SQL} AND fingerprint IS NOT NULL)
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

/// What a closer look found, by the pair's ids, smaller first. A pair is missing until it has one,
/// and when either file has changed since.
pub type Comparisons = HashMap<(FileId, FileId), bool>;

/// Whether a closer look could read each pair, by ids, smaller first.
pub type Readings = HashMap<(FileId, FileId), bool>;

/// The current comparisons among these files: whether each pair is of different pictures.
pub fn load_comparisons(
    connection: &Connection,
    file_ids: &[FileId],
) -> anyhow::Result<Comparisons> {
    Ok(load_answers(connection, file_ids)?
        .into_iter()
        .map(|(pair, variant)| (pair, variant != 0))
        .collect())
}

/// The pairs among these files a closer look has been at: whether it could read them.
pub fn load_readings(connection: &Connection, file_ids: &[FileId]) -> anyhow::Result<Readings> {
    Ok(load_answers(connection, file_ids)?
        .into_iter()
        .map(|(pair, variant)| (pair, variant != COULD_NOT_READ))
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

/// Forgets a root's prints and comparisons from before the current version, which cannot be
/// compared with new ones.
pub fn forget_outdated_details(connection: &Connection, root_id: RootId) -> anyhow::Result<()> {
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

/// A file to look at: where it is and the state its answer depends on.
#[derive(Clone)]
struct LookedAt {
    path: PathBuf,
    size: i64,
    mtime_ms: f64,
}

/// Takes a closer look at these pairs, smaller id first, and stores each answer. Files are read
/// once a group of pairs that share them, since decoding is nearly all the cost. Without libvips
/// it stores nothing, and the pairs wait for it.
pub fn run_comparison_pass(
    context: &PassContext<'_>,
    pairs: &[(FileId, FileId)],
) -> anyhow::Result<()> {
    let Some(vips) = context.media.loaded_vips() else {
        return Ok(());
    };
    let mut links = DisjointSets::default();
    for &(left, right) in pairs {
        links.union(left, right, 0);
    }
    let ids: Vec<FileId> = pairs
        .iter()
        .flat_map(|&(left, right)| [left, right])
        .collect();
    let params = SqlParams::new().with("ids", ids_param(&ids));
    let files: HashMap<FileId, LookedAt> = context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(
            "SELECT f.id, r.path, f.rel_path, f.size, f.mtime_ms
          FROM files f JOIN roots r ON r.id = f.root_id
          WHERE f.id IN (SELECT value FROM json_each($ids))",
        )?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok((
                row.get(0)?,
                LookedAt {
                    path: to_absolute_path(&row.get::<_, String>(1)?, &row.get::<_, String>(2)?),
                    size: row.get(3)?,
                    mtime_ms: row.get(4)?,
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })?;
    let mut groups: HashMap<FileId, Vec<(FileId, FileId)>> = HashMap::new();
    let mut members: Vec<(FileId, Vec<FileId>)> = links
        .clusters()
        .into_iter()
        .map(|(_, ids)| (ids[0], ids))
        .collect();
    members.sort_unstable_by_key(|(first, _)| *first);
    let group_of: HashMap<FileId, FileId> = members
        .iter()
        .flat_map(|(first, ids)| ids.iter().map(|id| (*id, *first)))
        .collect();
    for &pair in pairs {
        if let Some(group) = group_of.get(&pair.0) {
            groups.entry(*group).or_default().push(pair);
        }
    }
    let groups: Vec<Vec<(FileId, FileId)>> = groups.into_values().collect();

    for_each_concurrent(
        &groups,
        per_core(),
        context.progress,
        "Looking closer at similar versions",
        |group| {
            let mut looks: HashMap<FileId, Option<StillLook>> = HashMap::new();
            for &(left, right) in group {
                for id in [left, right] {
                    if let (false, Some(file)) = (looks.contains_key(&id), files.get(&id)) {
                        looks.insert(id, look_at_still(vips, &file.path).ok());
                    }
                }
            }
            let answers: Vec<_> = group
                .iter()
                .filter_map(|&(left, right)| {
                    let (left_file, right_file) = (files.get(&left)?, files.get(&right)?);
                    // A pair that cannot be read keeps both files, until the next analysis asks
                    // again. No answer goes in for a file that changed while it was being read:
                    // that pair is asked about again.
                    let variant = match (looks.get(&left)?, looks.get(&right)?) {
                        (Some(left_look), Some(right_look)) => {
                            i64::from(look_shows_variant(left_look, right_look))
                        }
                        _ => COULD_NOT_READ,
                    };
                    Some((
                        (left, left_file.size, left_file.mtime_ms),
                        (right, right_file.size, right_file.mtime_ms),
                        variant,
                    ))
                })
                .collect();
            context.catalog.blocking(move |connection| {
                let mut insert = connection.prepare_cached(
                    "INSERT OR REPLACE INTO file_comparisons (left_id, right_id, version, left_size,
                       left_mtime_ms, right_size, right_mtime_ms, variant)
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM files l, files r
                       WHERE l.id = ?1 AND l.size = ?4 AND l.mtime_ms = ?5
                         AND l.fingerprint IS NOT NULL
                         AND r.id = ?2 AND r.size = ?6 AND r.mtime_ms = ?7
                         AND r.fingerprint IS NOT NULL",
                )?;
                for (left, right, variant) in answers {
                    insert.execute(params![
                        left.0,
                        right.0,
                        DETAIL_VERSION,
                        left.1,
                        left.2,
                        right.1,
                        right.2,
                        variant
                    ])?;
                }
                Ok(())
            })
        },
    )
}
