import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { z } from "zod";

/** What a write statement did. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Named statement parameters, bound as `$name` in SQL. */
export type SqlParams = Record<string, SQLInputValue>;

/**
 * Each entry upgrades the catalog by one version (`PRAGMA user_version`). Entries only append;
 * an existing catalog replays the ones past its version.
 */
const MIGRATIONS: readonly string[] = [
  `
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
  `,
  `
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
  `,
  // Holding moved out of the root, so a held file's place is recorded whole. Rows from before
  // keep these null until the engine fills them in and moves their files out (see holding.ts).
  `
  ALTER TABLE holding ADD COLUMN hold_path TEXT;

  ALTER TABLE holding ADD COLUMN batch_path TEXT;
  `,
  // Finder's .DS_Store files are no longer catalogued.
  `
  DELETE FROM files WHERE lower(name) = '.ds_store';
  `,
  // An archive under an extension that names no other format (a game's .zipmod) is no longer
  // misnamed; the next scan identifies those archives again.
  `
  UPDATE files SET format = NULL, ext_mismatch = 0
    WHERE ext_mismatch = 1 AND format IN ('zip', 'rar', '7z');
  `,
  // Shrink remembers a video its AV1 re-encode did not make smaller, apart from Convert's mark.
  `
  ALTER TABLE files ADD COLUMN shrink_not_smaller INTEGER NOT NULL DEFAULT 0;
  `,
  // Detail prints for Spot variants, kept apart from files so 4 KB rows never slow its scans. A
  // print counts while its file still has the size and mtime it was made from.
  `
  CREATE TABLE file_details (
    file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    print BLOB,
    error TEXT
  );
  `,
  // Explorer's desktop.ini and thumbnail caches are no longer catalogued, as .DS_Store is not.
  `
  DELETE FROM files
    WHERE lower(name) IN ('desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db');
  `,
  // How long each SVT-AV1 encode took on this machine, so Shrink's time estimate follows it.
  `
  CREATE TABLE encode_timings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    encoder TEXT NOT NULL,
    pixels INTEGER NOT NULL,
    media_ms REAL NOT NULL,
    wall_ms REAL NOT NULL,
    at INTEGER NOT NULL
  );
  `,
];

/**
 * Per-connection tables rebuilt from the catalog on demand. `convertible_files` holds the files
 * the Convert step would change, refreshed with the engine's candidate cache, so file queries can
 * filter and count by it.
 */
const TEMP_TABLES = `
  CREATE TEMP TABLE IF NOT EXISTS convertible_files (
    id INTEGER PRIMARY KEY,
    root_id INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS temp.convertible_files_root ON convertible_files (root_id);
`;

/**
 * The catalog's SQLite file. Nothing here is authoritative: the archive on disk is, so a lost or
 * corrupt catalog is rebuilt by scanning again. Rows leave through `all` and `get`, which parse
 * them with the caller's schema.
 */
export class CatalogDatabase {
  private readonly db: DatabaseSync;

  private readonly statements = new Map<string, StatementSync>();

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
    this.db.exec(TEMP_TABLES);
  }

  close(): void {
    this.db.close();
  }

  run(sql: string, params: SqlParams = {}): RunResult {
    const result = this.statement(sql).run(params);

    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  all<T>(sql: string, schema: z.ZodType<T>, params: SqlParams = {}): T[] {
    return this.statement(sql)
      .all(params)
      .map((row) => schema.parse(row));
  }

  get<T>(sql: string, schema: z.ZodType<T>, params: SqlParams = {}): T | null {
    const row = this.statement(sql).get(params);

    return row === undefined ? null : schema.parse(row);
  }

  /** Runs `work` in one transaction, committing when it returns and rolling back if it throws. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      const result = work();
      this.db.exec("COMMIT");

      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");

      throw error;
    }
  }

  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);

    if (cached) {
      return cached;
    }

    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);

    return prepared;
  }

  private migrate(): void {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);

    for (let index = version; index < MIGRATIONS.length; index += 1) {
      const migration = MIGRATIONS[index];

      if (migration === undefined) {
        continue;
      }

      this.transaction(() => {
        this.db.exec(migration);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }
}
