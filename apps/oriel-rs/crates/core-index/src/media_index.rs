//! View's media index: a SQLite record of what each scan of a folder found, in the schema of
//! Electron Oriel's `db/mediaIndexService.ts` (and `db/schema.ts`, its Drizzle mirror).
//!
//! The file is `media-index.sqlite` in View's folder, as Electron Oriel keeps it in its own. The
//! schema is created by the same statements, whitespace included, so `sqlite_master` reads the
//! same in both apps' files, and `user_version` stays 0: Electron Oriel never sets it, adding its
//! one later column (`codec`) when a file lacks it instead. The connection is `oriel-runtime`'s,
//! on its own thread.
//!
//! The index is a cache: the gallery never reads from it, and a failure to write it is reported
//! without stopping a scan.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use oriel_runtime::Database;
use rusqlite::params;

use crate::catalog::CatalogItem;

/// The index's file in View's folder.
pub const MEDIA_INDEX_FILE_NAME: &str = "media-index.sqlite";

/// `mediaIndexService.ts`'s schema, exactly as it runs it.
pub const SCHEMA: &str = "
        CREATE TABLE IF NOT EXISTS scan_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL,
          recursive INTEGER NOT NULL,
          started_at_ms INTEGER NOT NULL,
          completed_at_ms INTEGER,
          status TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_index (
          path TEXT PRIMARY KEY,
          root_path TEXT NOT NULL,
          name TEXT NOT NULL,
          extension TEXT NOT NULL,
          media_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          codec TEXT,
          last_seen_scan_id INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_media_root_path
        ON media_index(root_path);

        CREATE INDEX IF NOT EXISTS idx_media_last_seen
        ON media_index(last_seen_scan_id);
      ";

/// What Diagnostics and Settings › Storage say about the index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaIndexStats {
    pub total_items: u64,
    pub unique_roots: u64,
    pub db_path: PathBuf,
}

/// One row of `media_index`, as a test or a later reader sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedRow {
    pub path: String,
    pub root_path: String,
    pub name: String,
    pub extension: String,
    pub media_type: String,
    pub size: i64,
    pub mtime_ms: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub duration_ms: Option<f64>,
    pub codec: Option<String>,
    pub last_seen_scan_id: i64,
}

/// View's index. Clones share the connection.
#[derive(Clone, Debug)]
pub struct MediaIndex {
    database: Database,
}

impl MediaIndex {
    /// Opens (or creates) `media-index.sqlite` in `folder`.
    pub async fn open_in(folder: &Path) -> Result<Self> {
        std::fs::create_dir_all(folder)
            .with_context(|| format!("cannot create {}", folder.display()))?;
        Self::open(folder.join(MEDIA_INDEX_FILE_NAME)).await
    }

    /// Opens (or creates) the index at `path`, creating its tables as Electron Oriel does.
    pub async fn open(path: PathBuf) -> Result<Self> {
        // No migrations: the schema is not versioned, so `user_version` stays 0 as in Electron
        // Oriel's files.
        let database = Database::open(path, &[]).await?;
        database
            .call(|connection| {
                connection.execute_batch(SCHEMA)?;
                ensure_column(connection, "media_index", "codec", "TEXT")?;
                Ok(())
            })
            .await
            .context("creating the media index's tables")?;
        Ok(Self { database })
    }

    pub fn path(&self) -> &Path {
        self.database.path()
    }

    /// Records the start of a scan of `root_path`, and returns its id.
    pub async fn start_scan(&self, root_path: String, recursive: bool) -> Result<i64> {
        self.database
            .call(move |connection| {
                connection.execute(
                    "insert into scan_runs (root_path, recursive, started_at_ms, status) \
                     values (?1, ?2, ?3, 'running')",
                    params![root_path, recursive, now_ms()],
                )?;
                Ok(connection.last_insert_rowid())
            })
            .await
    }

    /// Records `items` as seen by scan `scan_id` of `root_path`, replacing what the index held
    /// for their paths.
    pub async fn upsert_batch(
        &self,
        root_path: String,
        scan_id: i64,
        items: Vec<CatalogItem>,
    ) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        self.database
            .call(move |connection| {
                let now = now_ms();
                let transaction = connection.transaction()?;
                {
                    let mut statement = transaction.prepare_cached(
                        "insert into media_index (path, root_path, name, extension, media_type, \
                         size, mtime_ms, width, height, duration_ms, codec, last_seen_scan_id, \
                         updated_at_ms) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
                         ?12, ?13) on conflict (path) do update set root_path = excluded.root_path, \
                         name = excluded.name, extension = excluded.extension, media_type = \
                         excluded.media_type, size = excluded.size, mtime_ms = excluded.mtime_ms, \
                         width = excluded.width, height = excluded.height, duration_ms = \
                         excluded.duration_ms, codec = excluded.codec, last_seen_scan_id = \
                         excluded.last_seen_scan_id, updated_at_ms = excluded.updated_at_ms",
                    )?;
                    for item in &items {
                        statement.execute(params![
                            item.path,
                            root_path,
                            item.name,
                            item.extension,
                            item.media_type.as_str(),
                            item.size as i64,
                            item.mtime_ms,
                            item.width,
                            item.height,
                            item.duration_ms,
                            item.codec,
                            scan_id,
                            now,
                        ])?;
                    }
                }
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Ends scan `scan_id`: what it did not see under `root_path` is dropped, and the run is
    /// marked done.
    pub async fn finish_scan(&self, root_path: String, scan_id: i64) -> Result<()> {
        self.database
            .call(move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "delete from media_index where root_path = ?1 and last_seen_scan_id <> ?2",
                    params![root_path, scan_id],
                )?;
                transaction.execute(
                    "update scan_runs set completed_at_ms = ?1, status = 'done' where id = ?2",
                    params![now_ms(), scan_id],
                )?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Marks scan `scan_id` cancelled; what it recorded stays.
    pub async fn cancel_scan(&self, scan_id: i64) -> Result<()> {
        self.database
            .call(move |connection| {
                connection.execute(
                    "update scan_runs set completed_at_ms = ?1, status = 'cancelled' where id = ?2",
                    params![now_ms(), scan_id],
                )?;
                Ok(())
            })
            .await
    }

    pub async fn stats(&self) -> Result<MediaIndexStats> {
        let db_path = self.path().to_path_buf();
        let (total_items, unique_roots) = self
            .database
            .call(|connection| {
                Ok(connection.query_row(
                    "select count(*), count(distinct root_path) from media_index",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?)
            })
            .await?;
        Ok(MediaIndexStats {
            total_items: total_items.max(0) as u64,
            unique_roots: unique_roots.max(0) as u64,
            db_path,
        })
    }

    /// Forgets every item and every scan.
    pub async fn clear(&self) -> Result<()> {
        self.database
            .call(|connection| {
                let transaction = connection.transaction()?;
                transaction.execute("delete from media_index", [])?;
                transaction.execute("delete from scan_runs", [])?;
                transaction.commit()?;
                Ok(())
            })
            .await
    }

    /// Every row of `media_index`, by path: for tests and format checks.
    pub async fn rows(&self) -> Result<Vec<IndexedRow>> {
        self.database
            .call(|connection| {
                let mut statement = connection.prepare(
                    "select path, root_path, name, extension, media_type, size, mtime_ms, width, \
                     height, duration_ms, codec, last_seen_scan_id from media_index order by path",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok(IndexedRow {
                            path: row.get(0)?,
                            root_path: row.get(1)?,
                            name: row.get(2)?,
                            extension: row.get(3)?,
                            media_type: row.get(4)?,
                            size: row.get(5)?,
                            mtime_ms: row.get(6)?,
                            width: row.get(7)?,
                            height: row.get(8)?,
                            duration_ms: row.get(9)?,
                            codec: row.get(10)?,
                            last_seen_scan_id: row.get(11)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .await
    }

    /// The runs recorded, oldest first: `(root_path, recursive, status)`.
    pub async fn scan_runs(&self) -> Result<Vec<(String, bool, String)>> {
        self.database
            .call(|connection| {
                let mut statement = connection
                    .prepare("select root_path, recursive, status from scan_runs order by id")?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .await
    }

    /// Closes the connection once the calls already made have run.
    pub async fn close(self) -> Result<()> {
        self.database.close().await
    }
}

/// `ensureColumn`: adds a column a file from before it lacks.
fn ensure_column(
    connection: &rusqlite::Connection,
    table: &str,
    column: &str,
    column_type: &str,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = statement
        .query_map([], |row| row.get::<_, String>("name"))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|name| name == column);
    if !exists {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {column_type};"
        ))?;
    }
    Ok(())
}

/// `Date.now()`.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}
