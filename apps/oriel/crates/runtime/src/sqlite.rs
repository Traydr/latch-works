//! SQLite: one connection per catalog, on a thread of its own, called from async code.
//!
//! The connection is set up as Electron Oriel sets up its catalogs (glazier-core's
//! `catalog/database.ts`, View's `db/mediaIndexService.ts`), so either app can open the other's
//! files later: WAL, `synchronous = NORMAL`, foreign keys on, and no double-quoted string literals,
//! the last two being `node:sqlite`'s defaults.

use std::fmt;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, mpsc};
use std::time::Duration;

use anyhow::Context as _;
use futures::channel::oneshot;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, TransactionBehavior};

use crate::{panic_message, release_free_memory};

type Call = Box<dyn FnOnce(&mut Connection) + Send>;

enum Message {
    Call(Call),
    Close(oneshot::Sender<rusqlite::Result<()>>),
}

/// A catalog's connection, owned by its own thread. Calls run there one at a time, in the order
/// they were made, and their results come back as futures any executor can await. Clones share
/// the connection; it closes when the last clone is dropped, or on [`Database::close`].
#[derive(Clone)]
pub struct Database {
    path: Arc<Path>,
    calls: mpsc::Sender<Message>,
}

impl Database {
    /// Opens the catalog at `path`, creating it if absent, on a new thread; sets the connection up
    /// as Electron Oriel does; and brings the schema up to date with `migrations` (see
    /// [`migrate`]). Resolves once the catalog is ready, or with the error that stopped it.
    pub fn open(
        path: impl Into<PathBuf>,
        migrations: &'static [&'static str],
    ) -> impl Future<Output = anyhow::Result<Self>> + Send + 'static {
        let path: Arc<Path> = path.into().into();
        let (calls, receiver) = mpsc::channel();
        let (ready, opened) = oneshot::channel();
        let thread_path = path.clone();
        let name = format!(
            "sqlite {}",
            path.file_name()
                .unwrap_or(path.as_os_str())
                .to_string_lossy()
        );
        let spawned = std::thread::Builder::new()
            .name(name)
            .spawn(move || serve(&thread_path, migrations, ready, receiver));

        async move {
            spawned.context("starting the SQLite thread")?;
            opened
                .await
                .context("the SQLite thread stopped while opening")?
                .with_context(|| format!("opening {}", path.display()))?;
            Ok(Self { path, calls })
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Runs `call` with the connection on the catalog's thread and resolves to what it returns.
    /// A panic in `call` becomes its error, and the connection stays open for the next call.
    pub fn call<R, F>(&self, call: F) -> impl Future<Output = anyhow::Result<R>> + Send + 'static
    where
        F: FnOnce(&mut Connection) -> anyhow::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let (reply, result) = oneshot::channel();
        let sent = self.calls.send(Message::Call(Box::new(move |connection| {
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| call(connection)))
                .unwrap_or_else(|payload| {
                    Err(anyhow::anyhow!("panicked: {}", panic_message(payload)))
                });
            let _ = reply.send(outcome);
        })));
        let path = self.path.clone();

        async move {
            sent.map_err(|_| closed(&path))?;
            result.await.map_err(|_| closed(&path))?
        }
    }

    /// Closes the connection once the calls already made have run. SQLite checkpoints the WAL
    /// into the file as its last connection closes. Calls made afterwards, through any clone,
    /// fail.
    pub fn close(self) -> impl Future<Output = anyhow::Result<()>> + Send + 'static {
        let (reply, result) = oneshot::channel();
        let sent = self.calls.send(Message::Close(reply));
        let path = self.path.clone();

        async move {
            sent.map_err(|_| closed(&path))?;
            result
                .await
                .map_err(|_| closed(&path))?
                .with_context(|| format!("closing {}", path.display()))
        }
    }
}

impl fmt::Debug for Database {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Database")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn closed(path: &Path) -> anyhow::Error {
    anyhow::anyhow!("{} is closed", path.display())
}

/// How long a catalog's thread waits after its last call before it hands freed memory back.
const QUIET: Duration = Duration::from_millis(250);

/// The catalog's thread: opens the connection, then runs calls until every handle is gone or one
/// closes it. A query can build and drop buffers of several megabytes (Tidy's Overview reads every
/// file of a root), which the allocator would otherwise keep: 20 rounds of Overview's queries on
/// the 21k fixture left 450 MB with the process. So once calls have run and the thread has been
/// quiet for [`QUIET`], it hands that memory back, a fifth of a millisecond's work.
fn serve(
    path: &Path,
    migrations: &[&str],
    ready: oneshot::Sender<rusqlite::Result<()>>,
    calls: mpsc::Receiver<Message>,
) {
    let mut connection = match connect(path, migrations) {
        Ok(connection) => connection,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    let mut called = false;
    loop {
        let message = if called {
            match calls.recv_timeout(QUIET) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    release_free_memory();
                    called = false;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match calls.recv() {
                Ok(message) => message,
                Err(_) => return,
            }
        };
        match message {
            Message::Call(call) => {
                call(&mut connection);
                called = true;
            }
            Message::Close(reply) => {
                let _ = reply.send(connection.close().map_err(|(_, error)| error));
                return;
            }
        }
    }
}

fn connect(path: &Path, migrations: &[&str]) -> rusqlite::Result<Connection> {
    // rusqlite waits up to 5 s for a lock another connection holds, where `node:sqlite` fails at
    // once. With one connection per catalog that only matters when another process has the file
    // open, and there waiting is the kinder answer.
    let mut connection = Connection::open(path)?;
    // `journal_mode` answers with the mode it set; a file system that cannot hold a WAL leaves
    // the old one, which works, only slower and without concurrent readers.
    let mode: String =
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        log::warn!("{} stays in journal mode {mode}, not WAL", path.display());
    }
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    migrate(&mut connection, migrations)?;
    Ok(connection)
}

/// Brings a catalog's schema up to date, by glazier-core's rule: each entry of `migrations`
/// upgrades the catalog by one `user_version`, entries only append, and a catalog replays the
/// ones past its version, each in its own `BEGIN IMMEDIATE` transaction with its version bump. A
/// catalog newer than `migrations` is left as it is, as glazier-core leaves it.
pub fn migrate(connection: &mut Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let applied = usize::try_from(version).unwrap_or(0);
    for (index, migration) in migrations.iter().enumerate().skip(applied) {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration)?;
        transaction.pragma_update(None, "user_version", index as i64 + 1)?;
        transaction.commit()?;
    }
    Ok(())
}
