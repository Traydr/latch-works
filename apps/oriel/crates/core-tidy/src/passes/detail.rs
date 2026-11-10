//! The detail pass: detail prints for Spot variants, made only for the stills of similar sets,
//! kept apart from `files` (in `catalog::details`) so 4 KB rows never slow its scans. A print
//! counts while its file still has the size and mtime it was made from.
//!
//! The comparison pass takes a closer look at the pairs those prints call copies and keeps only
//! each pair's answer, since the looks themselves are too large to keep for every still.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::catalog::details::{
    CURRENT_DETAIL_JOIN, CloserLook, Compared, NO_DECODER, record_comparisons, record_detail,
};
use crate::catalog::files::{SelectedFile, SqlParams, ids_param, still_selected};
use crate::catalog::rows::to_absolute_path;
use crate::contract::FileId;
use crate::passes::{PassContext, for_each_concurrent, per_core};
use crate::similarity::{
    DETAIL_VERSION, DisjointSets, StillLook, detail_of_still, look_at_still, look_shows_variant,
    still_print_sql,
};

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
      WHERE f.id IN (SELECT value FROM json_each($ids)) AND {}
        AND d.file_id IS NULL
      ORDER BY f.id",
        still_print_sql("f.fingerprint")
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
                Some(Err(error)) => (None, Some(error.to_string())),
                None => (None, Some(NO_DECODER.to_owned())),
            };
            let file = file.clone();
            context
                .catalog
                .blocking(move |connection| record_detail(connection, &file, print, error))
        },
    )
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
                    let answer = match (looks.get(&left)?, looks.get(&right)?) {
                        (Some(left_look), Some(right_look)) => {
                            if look_shows_variant(left_look, right_look) {
                                CloserLook::Different
                            } else {
                                CloserLook::Copies
                            }
                        }
                        _ => CloserLook::Unreadable,
                    };
                    Some(Compared {
                        left: (left, left_file.size, left_file.mtime_ms),
                        right: (right, right_file.size, right_file.mtime_ms),
                        answer,
                    })
                })
                .collect();
            context
                .catalog
                .blocking(move |connection| record_comparisons(connection, &answers))
        },
    )
}
