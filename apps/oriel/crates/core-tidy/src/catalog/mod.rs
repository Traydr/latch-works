//! Tidy's catalog: one SQLite file in glazier-core's schema, on `oriel-runtime`'s SQLite thread.
//! Nothing in it is authoritative: the archive on disk is, so a lost catalog is rebuilt by
//! scanning again.

pub mod files;
pub mod roots;
pub mod rows;
pub mod schema;
pub mod tidy;

use std::future::Future;
use std::path::{Path, PathBuf};

use oriel_runtime::Database;
use rusqlite::Connection;

pub use rows::{FileRecord, to_absolute_path};
pub use schema::{MIGRATIONS, USER_VERSION};

/// The catalog file's name in Tidy's data folder, as glazier-core names it.
pub const CATALOG_FILE_NAME: &str = "catalog.sqlite";

/// A catalog's connection. Clones share it; every call runs on the catalog's own thread, in the
/// order made.
#[derive(Clone, Debug)]
pub struct Catalog {
    db: Database,
}

impl Catalog {
    /// Opens the catalog at `path`, creating it if absent, and brings it up to glazier-core's
    /// latest version.
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
    pub fn call<R, F>(&self, call: F) -> impl Future<Output = anyhow::Result<R>> + Send + 'static
    where
        F: FnOnce(&mut Connection) -> anyhow::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        self.db.call(call)
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

/// Runs `work` in one `BEGIN IMMEDIATE` transaction, as glazier-core's `transaction` does.
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

/// Milliseconds since the epoch, as `Date.now()` gives them.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
