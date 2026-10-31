//! The owner's word that some files are not duplicates of each other, from glazier-core's
//! `duplicates/dismissals.ts`.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::catalog::files::{get_file_records, roots_of_files};
use crate::catalog::now_ms;
use crate::contract::{DuplicateDismissal, FileId, RootId};

/// A set is dismissed when all its files fall inside one dismissal: a set that gains a file
/// comes back, one that loses files stays hidden. Dismissals a draft plan records count only once
/// the plan is applied.
#[derive(Clone, Debug, Default)]
pub struct Dismissals {
    files_by_id: HashMap<i64, HashSet<FileId>>,
    ids_by_file: HashMap<FileId, Vec<i64>>,
}

impl Dismissals {
    pub fn load(connection: &Connection) -> anyhow::Result<Self> {
        let mut dismissals = Self::default();
        let mut statement = connection.prepare_cached(
            "SELECT d.id, df.file_id FROM duplicate_dismissals d
        JOIN duplicate_dismissal_files df ON df.dismissal_id = d.id
        LEFT JOIN plans p ON p.id = d.plan_id
        WHERE d.plan_id IS NULL OR p.status != 'draft'
        ORDER BY d.id",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        for row in rows {
            let (id, file_id): (i64, FileId) = row?;
            dismissals
                .files_by_id
                .entry(id)
                .or_default()
                .insert(file_id);
            dismissals.ids_by_file.entry(file_id).or_default().push(id);
        }
        Ok(dismissals)
    }

    /// The dismissal that covers every one of these files, if any.
    pub fn covering(&self, file_ids: &[FileId]) -> Option<i64> {
        let first = file_ids.first()?;
        self.ids_by_file.get(first)?.iter().copied().find(|id| {
            self.files_by_id
                .get(id)
                .is_some_and(|files| file_ids.iter().all(|file| files.contains(file)))
        })
    }
}

/// Records that these files are not duplicates of each other, optionally as part of a plan.
pub fn add_dismissal(
    connection: &Connection,
    file_ids: &[FileId],
    plan_id: Option<i64>,
) -> anyhow::Result<i64> {
    let mut unique = Vec::new();
    for &id in file_ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let roots = roots_of_files(connection, &unique)?;
    let root = (roots.len() == 1).then(|| roots[0]);
    connection.execute(
        "INSERT INTO duplicate_dismissals (root_id, plan_id, created_at) VALUES (?1, ?2, ?3)",
        params![root, plan_id, now_ms()],
    )?;
    let dismissal = connection.last_insert_rowid();
    let mut insert = connection.prepare_cached(
        "INSERT INTO duplicate_dismissal_files (dismissal_id, file_id)
        SELECT ?1, id FROM files WHERE id = ?2",
    )?;
    for id in unique {
        insert.execute([dismissal, id])?;
    }
    Ok(dismissal)
}

pub fn remove_dismissal(connection: &Connection, dismissal_id: i64) -> anyhow::Result<()> {
    connection.execute(
        "DELETE FROM duplicate_dismissals WHERE id = ?1",
        [dismissal_id],
    )?;
    Ok(())
}

/// The dismissals the owner made by hand under a root, newest first, at most `limit`, each
/// with its files still in the catalog: History lists them with the duplicate decisions, and
/// their Undo is [`remove_dismissal`]. Those a plan recorded are the plan's, and go with its
/// Undo; a dismissal whose files are all gone is left out. A dismissal of files under several
/// roots (none recorded) is listed under each.
pub fn list_dismissals(
    connection: &Connection,
    root_id: RootId,
    limit: usize,
) -> anyhow::Result<Vec<DuplicateDismissal>> {
    let mut statement = connection.prepare_cached(
        "SELECT d.id, d.created_at FROM duplicate_dismissals d
        WHERE d.plan_id IS NULL
          AND (d.root_id = ?1 OR (d.root_id IS NULL AND EXISTS (
            SELECT 1 FROM duplicate_dismissal_files df JOIN files f ON f.id = df.file_id
            WHERE df.dismissal_id = d.id AND f.root_id = ?1)))
          AND EXISTS (SELECT 1 FROM duplicate_dismissal_files df WHERE df.dismissal_id = d.id)
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ?2",
    )?;
    let heads: Vec<(i64, i64)> = statement
        .query_map(params![root_id, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut files_of = connection
        .prepare_cached("SELECT file_id FROM duplicate_dismissal_files WHERE dismissal_id = ?1")?;
    let mut dismissals = Vec::with_capacity(heads.len());
    for (id, created_at) in heads {
        let ids: Vec<FileId> = files_of
            .query_map([id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut files: Vec<_> = get_file_records(connection, &ids)?
            .iter()
            .map(|record| record.to_file_row())
            .collect();
        files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let first_hash = files.first().and_then(|file| file.sha256.as_deref());
        let exact = first_hash.is_some()
            && files
                .iter()
                .all(|file| file.sha256.as_deref() == first_hash);
        dismissals.push(DuplicateDismissal {
            id,
            created_at,
            exact,
            files,
        });
    }
    Ok(dismissals)
}
