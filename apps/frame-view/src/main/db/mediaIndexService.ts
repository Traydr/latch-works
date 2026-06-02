import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Result, type Result as ResultType } from 'better-result';
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

import type { MediaIndexStats, MediaItem } from '../../shared/types';
import { type DatabaseError, unexpectedDatabaseError } from '../errors';
import { mediaIndexTable, scanRunsTable } from './schema';

type MediaIndexDatabase = ReturnType<
  typeof drizzle<{
    mediaIndexTable: typeof mediaIndexTable;
    scanRunsTable: typeof scanRunsTable;
  }>
>;

export class MediaIndexService {
  private readonly dbPath: string;

  private db: MediaIndexDatabase | null = null;
  private sqlite: DatabaseSync | null = null;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, 'media-index.sqlite');
  }

  init(): ResultType<void, DatabaseError> {
    try {
      this.sqlite = new DatabaseSync(this.dbPath);
      this.sqlite.exec('PRAGMA journal_mode = WAL;');
      this.sqlite.exec('PRAGMA synchronous = NORMAL;');

      this.sqlite.exec(`
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
      `);

      this.ensureColumn('media_index', 'codec', 'TEXT');
      this.db = drizzle(
        async (statementSql, params, method) => {
          const database = this.requireSqlite();
          const statement = database.prepare(statementSql);

          switch (method) {
            case 'run':
              statement.run(...params);
              return { rows: [] };
            case 'get': {
              const row = statement.get(...params);
              return { rows: row ? [row] : [] };
            }
            case 'values': {
              const rows = statement
                .all(...params)
                .map((row) => Object.values(row as Record<string, unknown>));
              return { rows };
            }
            default:
              return { rows: statement.all(...params) };
          }
        },
        {
          schema: {
            mediaIndexTable,
            scanRunsTable,
          },
        },
      );
      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-init', error));
    }
  }

  getDbPath(): string {
    return this.dbPath;
  }

  async startScan(
    rootPath: string,
    recursive: boolean,
  ): Promise<ResultType<number, DatabaseError>> {
    try {
      const database = this.requireDb();
      const result = await database
        .insert(scanRunsTable)
        .values({
          rootPath,
          recursive,
          startedAtMs: Date.now(),
          status: 'running',
        })
        .returning({ id: scanRunsTable.id })
        .get();

      return Result.ok(result.id);
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-start-scan', error));
    }
  }

  async upsertBatch(
    rootPath: string,
    scanId: number,
    items: MediaItem[],
  ): Promise<ResultType<void, DatabaseError>> {
    if (items.length === 0) {
      return Result.ok();
    }

    const now = Date.now();

    try {
      const database = this.requireDb();
      await database.transaction(async (tx) => {
        for (const item of items) {
          await tx
            .insert(mediaIndexTable)
            .values({
              path: item.path,
              rootPath,
              name: item.name,
              extension: item.extension,
              mediaType: item.mediaType,
              size: item.size,
              mtimeMs: item.mtimeMs,
              width: item.width ?? null,
              height: item.height ?? null,
              durationMs: item.durationMs ?? null,
              codec: item.codec ?? null,
              lastSeenScanId: scanId,
              updatedAtMs: now,
            })
            .onConflictDoUpdate({
              target: mediaIndexTable.path,
              set: {
                rootPath,
                name: item.name,
                extension: item.extension,
                mediaType: item.mediaType,
                size: item.size,
                mtimeMs: item.mtimeMs,
                width: item.width ?? null,
                height: item.height ?? null,
                durationMs: item.durationMs ?? null,
                codec: item.codec ?? null,
                lastSeenScanId: scanId,
                updatedAtMs: now,
              },
            })
            .run();
        }
      });
      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-upsert-batch', error));
    }
  }

  async finishScan(rootPath: string, scanId: number): Promise<ResultType<void, DatabaseError>> {
    try {
      const database = this.requireDb();
      await database.transaction(async (tx) => {
        await tx
          .delete(mediaIndexTable)
          .where(
            and(eq(mediaIndexTable.rootPath, rootPath), ne(mediaIndexTable.lastSeenScanId, scanId)),
          )
          .run();

        await tx
          .update(scanRunsTable)
          .set({
            completedAtMs: Date.now(),
            status: 'done',
          })
          .where(eq(scanRunsTable.id, scanId))
          .run();
      });

      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-finish-scan', error));
    }
  }

  async cancelScan(scanId: number): Promise<ResultType<void, DatabaseError>> {
    try {
      await this.requireDb()
        .update(scanRunsTable)
        .set({
          completedAtMs: Date.now(),
          status: 'cancelled',
        })
        .where(eq(scanRunsTable.id, scanId))
        .run();

      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-cancel-scan', error));
    }
  }

  async getStats(): Promise<ResultType<MediaIndexStats, DatabaseError>> {
    try {
      const totals = await this.requireDb()
        .select({
          totalItems: sql<number>`count(*)`,
          uniqueRoots: sql<number>`count(distinct ${mediaIndexTable.rootPath})`,
        })
        .from(mediaIndexTable)
        .get();

      return Result.ok({
        totalItems: totals?.totalItems ?? 0,
        uniqueRoots: totals?.uniqueRoots ?? 0,
        dbPath: this.dbPath,
      });
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-get-stats', error));
    }
  }

  async clear(): Promise<ResultType<void, DatabaseError>> {
    try {
      await this.requireDb().transaction(async (tx) => {
        await tx.delete(mediaIndexTable).run();
        await tx.delete(scanRunsTable).run();
      });

      return Result.ok();
    } catch (error) {
      return Result.err(unexpectedDatabaseError('media-index-clear', error));
    }
  }

  private requireDb(): MediaIndexDatabase {
    if (!this.db) {
      throw new Error('Media index database is not initialized');
    }

    return this.db;
  }

  private requireSqlite(): DatabaseSync {
    if (!this.sqlite) {
      throw new Error('Media index database is not initialized');
    }

    return this.sqlite;
  }

  private ensureColumn(tableName: string, columnName: string, columnType: string): void {
    const database = this.requireSqlite();
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType};`);
  }
}
