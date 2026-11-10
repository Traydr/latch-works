//! Where the catalog stands, so a result worked out from it is kept until the catalog changes.
//!
//! Every write goes through the catalog's one connection, which counts the rows it changes, and
//! SQLite says when another connection wrote. The per-connection `convertible_files` table is no
//! change to the catalog, so its writes are counted apart and left out. Fingerprints have a
//! generation of their own, moved only by the writes that make or drop prints for good: a scan,
//! the fingerprint pass once it ends, and a root leaving. A change rewriting a set's files leaves
//! it, so the similar clusters made from the prints stay through the change and the analysis
//! after it.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

/// Two equal states have no change to the catalog between them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CatalogState {
    changes: u64,
    data_version: i64,
}

impl CatalogState {
    /// Moves only when another connection writes.
    pub(crate) fn data_version(&self) -> i64 {
        self.data_version
    }
}

/// Counts the rows written to the per-connection tables, which change nothing in the catalog.
#[derive(Debug, Default)]
pub(crate) struct ScratchWrites(AtomicU64);

impl ScratchWrites {
    /// Runs `write` on a per-connection table, counting the rows it changes as no change.
    pub(crate) fn uncounted<R>(
        &self,
        connection: &mut Connection,
        write: impl FnOnce(&mut Connection) -> anyhow::Result<R>,
    ) -> anyhow::Result<R> {
        let before = connection.total_changes();
        let result = write(connection);
        let written = connection.total_changes().saturating_sub(before);
        self.0.fetch_add(written, Ordering::AcqRel);
        result
    }

    /// Where the catalog stands now.
    pub(crate) fn state(&self, connection: &Connection) -> anyhow::Result<CatalogState> {
        Ok(CatalogState {
            changes: connection
                .total_changes()
                .saturating_sub(self.0.load(Ordering::Acquire)),
            data_version: connection.query_row("PRAGMA data_version", [], |row| row.get(0))?,
        })
    }
}

/// The fingerprints' generation; see the module's documentation.
pub(crate) fn print_generation(connection: &Connection) -> anyhow::Result<i64> {
    Ok(connection.query_row(
        "SELECT generation FROM print_generation WHERE id = 1",
        [],
        |row| row.get(0),
    )?)
}

/// Moves the fingerprints' generation on.
pub(crate) fn prints_changed(connection: &Connection) -> anyhow::Result<()> {
    connection.execute(
        "UPDATE print_generation SET generation = generation + 1 WHERE id = 1",
        [],
    )?;
    Ok(())
}
