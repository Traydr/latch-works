//! The sniff pass, from glazier-core's `passes/sniff-pass.ts`: reads the first bytes of every
//! file not yet identified and records its real format.

use crate::catalog::files::{SqlParams, initial_kind};
use crate::catalog::rows::to_absolute_path;
use crate::contract::{FileFormat, FileId};
use crate::passes::{PassContext, for_each_concurrent};
use crate::scan::{is_extension_mismatch, kind_for_format, sniff_file};

struct Pending {
    id: FileId,
    root_path: String,
    rel_path: String,
    name: String,
    ext: String,
    size: i64,
    is_junk: bool,
}

pub fn run_sniff_pass(context: &PassContext<'_>) -> anyhow::Result<()> {
    let mut params = SqlParams::new();
    let sql = format!(
        "SELECT f.id, r.path AS root_path, f.rel_path, f.name, f.ext, f.size, f.is_junk
      FROM files f JOIN roots r ON r.id = f.root_id
      WHERE f.format IS NULL {}",
        context.root_clause(&mut params)
    );
    let pending: Vec<Pending> = context.catalog.blocking(move |connection| {
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(&*params.named(), |row| {
            Ok(Pending {
                id: row.get(0)?,
                root_path: row.get(1)?,
                rel_path: row.get(2)?,
                name: row.get(3)?,
                ext: row.get(4)?,
                size: row.get(5)?,
                is_junk: row.get::<_, i64>(6)? == 1,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })?;

    for_each_concurrent(
        &pending,
        16,
        context.progress,
        "Identifying formats",
        |file| {
            let path = to_absolute_path(&file.root_path, &file.rel_path);
            let format = sniff_file(&path, file.size).unwrap_or(FileFormat::Unknown);
            let unidentified = matches!(format, FileFormat::Unknown | FileFormat::Empty);
            let kind = if file.is_junk || unidentified {
                initial_kind(&file.name, file.is_junk)
            } else {
                kind_for_format(format)
            };
            let mismatch = !file.is_junk && is_extension_mismatch(format, &file.ext);
            let id = file.id;
            context.catalog.blocking(move |connection| {
                connection.execute(
                    "UPDATE files SET format = ?1, kind = ?2, ext_mismatch = ?3 WHERE id = ?4",
                    rusqlite::params![format.as_str(), kind.as_str(), i64::from(mismatch), id],
                )?;
                Ok(())
            })
        },
    )
}
