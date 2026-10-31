//! The catalog's schema, which is Oriel's own. It began as glazier-core's
//! `catalog/database.ts`, so a catalog Electron Oriel left opens and upgrades in place; with
//! glazier-core gone, nothing else has to match it.

/// Each entry upgrades the catalog by one version (`PRAGMA user_version`). Entries only append,
/// and an existing catalog replays the ones past its version, so a shipped entry never changes:
/// a new table or column is a new entry at the end.
pub const MIGRATIONS: &[&str] = &[
    "
  CREATE TABLE roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    added_at INTEGER NOT NULL,
    last_scan_at INTEGER
  );

  CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    dir TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    ctime_ms REAL NOT NULL,
    dev TEXT NOT NULL,
    ino TEXT NOT NULL,
    is_junk INTEGER NOT NULL,
    last_seen_scan INTEGER NOT NULL,
    kind TEXT NOT NULL,
    format TEXT,
    ext_mismatch INTEGER NOT NULL DEFAULT 0,
    probe_version INTEGER NOT NULL DEFAULT 0,
    probe_error TEXT,
    width INTEGER,
    height INTEGER,
    frames INTEGER,
    has_alpha INTEGER,
    duration_ms REAL,
    video_codec TEXT,
    audio_codec TEXT,
    audio_streams INTEGER,
    bitrate REAL,
    head_hash TEXT,
    sha256 TEXT,
    fingerprint_version INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    fingerprint_error TEXT,
    loudness_version INTEGER NOT NULL DEFAULT 0,
    loudness_max_db REAL,
    UNIQUE (root_id, rel_path)
  );

  CREATE INDEX files_root_dir ON files (root_id, dir);
  CREATE INDEX files_size ON files (size);
  CREATE INDEX files_sha256 ON files (sha256);
  CREATE INDEX files_root_kind ON files (root_id, kind);

  CREATE TABLE empty_folders (
    root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    PRIMARY KEY (root_id, rel_path)
  );

  CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL
  );

  CREATE TABLE plan_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    from_rel TEXT NOT NULL,
    to_abs TEXT,
    spec TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    expected_mtime_ms REAL NOT NULL,
    expected_ctime_ms REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT,
    bytes_before INTEGER NOT NULL,
    bytes_after INTEGER,
    holding_id INTEGER,
    output_mtime_ms REAL,
    done_at INTEGER,
    undone_at INTEGER
  );

  CREATE INDEX plan_steps_plan ON plan_steps (plan_id, id);

  CREATE TABLE holding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    original_rel TEXT NOT NULL,
    hold_rel TEXT NOT NULL,
    batch TEXT NOT NULL,
    size INTEGER NOT NULL,
    held_at INTEGER NOT NULL,
    plan_id INTEGER,
    reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'held'
  );

  CREATE INDEX holding_root_state ON holding (root_id, state);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ",
    "
  ALTER TABLE files ADD COLUMN optimize_not_smaller INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE plans ADD COLUMN count INTEGER NOT NULL DEFAULT 0;

  UPDATE plans SET count = CASE
    WHEN kind = 'resolve-duplicates'
      THEN (SELECT COUNT(DISTINCT s.spec) FROM plan_steps s WHERE s.plan_id = plans.id)
    WHEN kind = 'remove-empty-folders'
      THEN (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = plans.id AND s.action = 'remove-folder')
    ELSE (SELECT COUNT(*) FROM plan_steps s WHERE s.plan_id = plans.id) END;

  CREATE TABLE duplicate_dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id INTEGER REFERENCES roots(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX duplicate_dismissals_plan ON duplicate_dismissals (plan_id);

  CREATE TABLE duplicate_dismissal_files (
    dismissal_id INTEGER NOT NULL REFERENCES duplicate_dismissals(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (dismissal_id, file_id)
  );

  CREATE INDEX duplicate_dismissal_files_file ON duplicate_dismissal_files (file_id);
  ",
    "
  ALTER TABLE holding ADD COLUMN hold_path TEXT;

  ALTER TABLE holding ADD COLUMN batch_path TEXT;
  ",
    "
  DELETE FROM files WHERE lower(name) = '.ds_store';
  ",
    "
  UPDATE files SET format = NULL, ext_mismatch = 0
    WHERE ext_mismatch = 1 AND format IN ('zip', 'rar', '7z');
  ",
    "
  ALTER TABLE files ADD COLUMN shrink_not_smaller INTEGER NOT NULL DEFAULT 0;
  ",
    "
  CREATE TABLE file_details (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    print BLOB,
    error TEXT
  );
  ",
    "
  DELETE FROM files
    WHERE lower(name) IN ('desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db');
  ",
    "
  CREATE TABLE encode_timings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    encoder TEXT NOT NULL,
    pixels INTEGER NOT NULL,
    media_ms REAL NOT NULL,
    wall_ms REAL NOT NULL,
    at INTEGER NOT NULL
  );
  ",
];

/// The catalog's version once every migration ran.
pub const USER_VERSION: i64 = MIGRATIONS.len() as i64;

/// Per-connection tables rebuilt from the catalog on demand. `convertible_files` holds the files
/// the Convert step would change, so Library queries can filter and count by it.
pub const TEMP_TABLES: &str = "
  CREATE TEMP TABLE IF NOT EXISTS convertible_files (
    id INTEGER PRIMARY KEY,
    root_id INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS temp.convertible_files_root ON convertible_files (root_id);
";
