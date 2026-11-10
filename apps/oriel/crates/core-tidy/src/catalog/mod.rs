//! Tidy's catalog: one SQLite file, on `oriel-runtime`'s SQLite thread. This module owns the
//! schema, the roots and the owner's settings, and every write to a file's row and to what
//! hangs off it (empty folders, details and comparisons, the print generation, encode timings).
//! The journal (`plans`), holding and dismissals write their own tables, and a feature's own
//! question (Duplicates' sets, Convert's and Shrink's candidates, a pass's work list) reads the
//! tables directly. Nothing in it is authoritative: the archive on disk is, so a lost catalog
//! is rebuilt by scanning again.

pub mod details;
pub mod files;
pub mod roots;
pub mod rows;
pub mod schema;
pub(crate) mod state;
pub mod tidy;
pub(crate) mod timings;

use std::future::Future;
use std::path::{Path, PathBuf};

use oriel_runtime::Database;
use rusqlite::Connection;

use schema::MIGRATIONS;

/// A catalog's connection. Clones share it; every call runs on the catalog's own thread, in the
/// order made.
#[derive(Clone, Debug)]
pub struct Catalog {
    db: Database,
}

impl Catalog {
    /// Opens the catalog at `path`, creating it if absent, and brings it up to the latest
    /// version.
    pub async fn open(path: impl Into<PathBuf>) -> anyhow::Result<Self> {
        let db = Database::open(path, MIGRATIONS).await?;
        db.call(|connection| Ok(connection.execute_batch(schema::TEMP_TABLES)?))
            .await?;
        Ok(Self { db })
    }

    /// [`Catalog::open`], blocking this thread until it is open.
    pub fn open_blocking(path: impl Into<PathBuf>) -> anyhow::Result<Self> {
        futures::executor::block_on(Self::open(path))
    }

    pub fn path(&self) -> &Path {
        self.db.path()
    }

    /// Runs `call` with the connection on the catalog's thread.
    pub fn call<R, F>(&self, call: F) -> impl Future<Output = anyhow::Result<R>> + Send + use<R, F>
    where
        F: FnOnce(&mut Connection) -> anyhow::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        // Its own handle, so the answer does not borrow the catalog.
        let db = self.db.clone();
        async move { db.call(call).await }
    }

    /// [`Catalog::call`] from a worker thread, waiting for the answer. Never call it from an
    /// executor's thread.
    pub fn blocking<R, F>(&self, call: F) -> anyhow::Result<R>
    where
        F: FnOnce(&mut Connection) -> anyhow::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        futures::executor::block_on(self.db.call(call))
    }

    /// Closes the catalog once the calls already made have run.
    pub async fn close(self) -> anyhow::Result<()> {
        self.db.close().await
    }
}

/// How far a catalog has come, for measuring a run from outside the app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CatalogCounts {
    pub files: i64,
    pub fingerprinted: i64,
    pub fingerprint_errors: i64,
    pub probe_errors: i64,
    pub soundtracks_measured: i64,
    pub hashed: i64,
    /// The latest scan of any root.
    pub last_scan_at: Option<i64>,
}

/// Reads a catalog's counts without writing to it, once the app that keeps it has quit.
pub fn catalog_counts(path: &Path) -> anyhow::Result<CatalogCounts> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(connection.query_row(
        "SELECT COUNT(*), COUNT(fingerprint), COUNT(fingerprint_error), COUNT(probe_error),
          SUM(loudness_version > 0), COUNT(sha256), (SELECT MAX(last_scan_at) FROM roots)
        FROM files",
        [],
        |row| {
            Ok(CatalogCounts {
                files: row.get(0)?,
                fingerprinted: row.get(1)?,
                fingerprint_errors: row.get(2)?,
                probe_errors: row.get(3)?,
                soundtracks_measured: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                hashed: row.get(5)?,
                last_scan_at: row.get(6)?,
            })
        },
    )?)
}

/// Runs `work` in one `BEGIN IMMEDIATE` transaction.
pub(crate) fn transaction<R>(
    connection: &mut Connection,
    work: impl FnOnce(&rusqlite::Transaction<'_>) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = work(&transaction)?;
    transaction.commit()?;
    Ok(result)
}

/// [`oriel_core_domain::format::now_ms`] as the catalog stores it.
pub(crate) fn now_ms() -> i64 {
    oriel_core_domain::format::now_ms() as i64
}
