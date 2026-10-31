//! Electron Oriel's SQLite files, read through copies. Even a read-only connection may write a
//! database's `-shm` file, so the import never opens Electron Oriel's own: it copies the file with
//! its `-wal` and `-shm` and opens the copy, whose first connection replays the log into it.

use std::path::Path;

use anyhow::{Context as _, bail};
use rusqlite::Connection;

use crate::files::{Progress, copy_file, with_suffix};

/// Copies the database at `source` (with its log and shared memory, when there) to `copy`, and
/// opens the copy, checked.
pub(crate) fn open_copy(
    source: &Path,
    copy: &Path,
    progress: &Progress,
) -> anyhow::Result<Connection> {
    for suffix in ["", "-wal", "-shm"] {
        let from = with_suffix(source, suffix);
        if suffix.is_empty() || from.is_file() {
            copy_file(&from, &with_suffix(copy, suffix), progress)
                .with_context(|| format!("copying {}", from.display()))?;
        }
    }
    let connection =
        Connection::open(copy).with_context(|| format!("opening {}", copy.display()))?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .context("checking the copy")?;
    if check != "ok" {
        bail!("the database is damaged: {check}");
    }
    Ok(connection)
}

/// Folds the copy's log into its file and closes it, so the file stands alone.
pub(crate) fn close_copy(connection: Connection) -> anyhow::Result<()> {
    connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .context("folding the log into the copy")?;
    connection
        .close()
        .map_err(|(_, error)| error)
        .context("closing the copy")
}

/// `PRAGMA user_version`.
pub(crate) fn user_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}
