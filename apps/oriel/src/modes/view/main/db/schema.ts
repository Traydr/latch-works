import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const scanRunsTable = sqliteTable('scan_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rootPath: text('root_path').notNull(),
  recursive: integer('recursive', { mode: 'boolean' }).notNull(),
  startedAtMs: integer('started_at_ms').notNull(),
  completedAtMs: integer('completed_at_ms'),
  status: text('status').notNull(),
});

export const mediaIndexTable = sqliteTable(
  'media_index',
  {
    path: text('path').primaryKey(),
    rootPath: text('root_path').notNull(),
    name: text('name').notNull(),
    extension: text('extension').notNull(),
    mediaType: text('media_type').notNull(),
    size: integer('size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    codec: text('codec'),
    lastSeenScanId: integer('last_seen_scan_id').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    index('idx_media_root_path').on(table.rootPath),
    index('idx_media_last_seen').on(table.lastSeenScanId),
  ],
);
