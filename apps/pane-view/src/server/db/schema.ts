import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const mediaTypeEnum = pgEnum("media_type", ["image", "gif", "video", "pdf", "unknown"]);
export const collectionTypeEnum = pgEnum("collection_type", [
  "comic",
  "story-series",
  "folder",
  "source-post",
]);
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const syncActionEnum = pgEnum("sync_action", ["upload", "update", "keep", "delete"]);
export const thumbnailStatusEnum = pgEnum("thumbnail_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);
export const derivativeQueueSourceEnum = pgEnum("derivative_queue_source", [
  "prewarm",
  "on-demand",
]);
export const derivativeQueueVariantEnum = pgEnum("derivative_queue_variant", [
  "thumbnail",
  "preview",
]);
export const subjectTypeEnum = pgEnum("subject_type", ["library_entry", "collection"]);
export const maintenanceJobTypeEnum = pgEnum("maintenance_job_type", ["library_hard_wipe"]);
export const maintenanceJobStatusEnum = pgEnum("maintenance_job_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);
export const sourceTypeEnum = pgEnum("source_type", [
  "cli",
  "local",
  "extension",
  "tresorit",
  "manual",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().default("Pane View Owner"),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    tokenHash: text("token_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenUnique: uniqueIndex("sessions_token_unique").on(table.token),
    tokenHashUnique: uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    userIdIndex: index("sessions_user_id_idx").on(table.userId),
  }),
);

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIndex: index("accounts_user_id_idx").on(table.userId),
  }),
);

export const verifications = pgTable("verifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
  }),
);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: sourceTypeEnum("type").notNull(),
    name: text("name").notNull(),
    basePath: text("base_path"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex("sources_name_unique").on(table.name),
  }),
);

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id").references(() => sources.id),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sourceRoot: text("source_root").notNull(),
  status: syncRunStatusEnum("status").notNull(),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  manifestKey: text("manifest_key"),
  error: text("error"),
  cliVersion: text("cli_version"),
  createdByTokenId: uuid("created_by_token_id").references(() => apiTokens.id),
});

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    extension: text("extension").notNull(),
    mediaType: mediaTypeEnum("media_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    pageCount: integer("page_count"),
    objectKey: text("object_key").notNull(),
    storageProvider: text("storage_provider").notNull().default("s3"),
    bucket: text("bucket"),
    etag: text("etag"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdBySyncRunId: uuid("created_by_sync_run_id").references(() => syncRuns.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sha256SizeUnique: uniqueIndex("media_objects_sha256_size_unique").on(table.sha256, table.size),
  }),
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    path: text("path").notNull(),
    parentPath: text("parent_path").notNull().default(""),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    depth: integer("depth").notNull().default(0),
    entryCount: integer("entry_count").notNull().default(0),
    folderCount: integer("folder_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    pathUnique: uniqueIndex("folders_path_unique").on(table.path),
    parentIndex: index("folders_parent_path_idx").on(table.parentPath),
    deletedAtIndex: index("folders_deleted_at_idx").on(table.deletedAt),
  }),
);

export const libraryEntries = pgTable(
  "library_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mediaObjectId: uuid("media_object_id")
      .notNull()
      .references(() => mediaObjects.id, { onDelete: "cascade" }),
    logicalPath: text("logical_path").notNull(),
    parentPath: text("parent_path").notNull().default(""),
    filename: text("filename").notNull(),
    mtimeMs: bigint("mtime_ms", { mode: "number" }).notNull(),
    size: bigint("size", { mode: "number" }),
    sha256: text("sha256"),
    source: text("source"),
    sourceId: text("source_id"),
    sourceRefId: uuid("source_ref_id").references(() => sources.id),
    lastSyncRunId: uuid("last_sync_run_id").references(() => syncRuns.id),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    hidden: boolean("hidden").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    contentChangedAt: timestamp("content_changed_at", { withTimezone: true }),
    pathChangedAt: timestamp("path_changed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    logicalPathUnique: uniqueIndex("library_entries_logical_path_unique").on(table.logicalPath),
    parentIndex: index("library_entries_parent_path_idx").on(table.parentPath),
    mediaObjectIndex: index("library_entries_media_object_id_idx").on(table.mediaObjectId),
    deletedAtIndex: index("library_entries_deleted_at_idx").on(table.deletedAt),
  }),
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: collectionTypeEnum("type").notNull(),
    name: text("name").notNull(),
    slug: text("slug"),
    description: text("description"),
    path: text("path").notNull(),
    sourceId: uuid("source_id").references(() => sources.id),
    externalSourceId: text("external_source_id"),
    coverEntryId: uuid("cover_entry_id").references(() => libraryEntries.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    pathTypeUnique: uniqueIndex("collections_path_type_unique").on(table.path, table.type),
  }),
);

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    libraryEntryId: uuid("library_entry_id")
      .notNull()
      .references(() => libraryEntries.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.collectionId, table.libraryEntryId] }),
    collectionPositionIndex: index("collection_items_collection_position_idx").on(
      table.collectionId,
      table.position,
    ),
    collectionPositionUnique: uniqueIndex("collection_items_collection_position_unique").on(
      table.collectionId,
      table.position,
    ),
  }),
);

export const thumbnails = pgTable(
  "thumbnails",
  {
    mediaObjectId: uuid("media_object_id")
      .notNull()
      .references(() => mediaObjects.id, { onDelete: "cascade" }),
    size: integer("size").notNull(),
    objectKey: text("object_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    status: thumbnailStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    // Worker-safe scheduling fields. `processingToken` is a lease owner id so an
    // external optimizer and Pane View never double-generate the same row.
    processingToken: text("processing_token"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    queueSource: derivativeQueueSourceEnum("queue_source").notNull().default("prewarm"),
    queueVariant: derivativeQueueVariantEnum("queue_variant").notNull().default("thumbnail"),
    queuePriority: integer("queue_priority").notNull().default(0),
    priorityAt: timestamp("priority_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.mediaObjectId, table.size] }),
    statusIndex: index("thumbnails_status_idx").on(table.mediaObjectId, table.size, table.status),
    // Partial index for the optimizer claim scan over schedulable pending rows.
    pendingPriorityIndex: index("thumbnails_pending_priority_idx")
      .on(table.queuePriority, table.priorityAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  }),
);

export const syncRunItems = pgTable(
  "sync_run_items",
  {
    syncRunId: uuid("sync_run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    logicalPath: text("logical_path").notNull(),
    mediaObjectId: uuid("media_object_id").references(() => mediaObjects.id, {
      onDelete: "set null",
    }),
    previousMediaObjectId: uuid("previous_media_object_id").references(() => mediaObjects.id, {
      onDelete: "set null",
    }),
    previousLogicalPath: text("previous_logical_path"),
    action: syncActionEnum("action").notNull(),
    error: text("error"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.syncRunId, table.logicalPath] }),
  }),
);

export const viewerState = pgTable(
  "viewer_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id").notNull(),
    subjectType: subjectTypeEnum("subject_type").notNull(),
    positionMs: integer("position_ms"),
    page: integer("page"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.subjectId, table.subjectType] }),
  }),
);

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id").notNull(),
    subjectType: subjectTypeEnum("subject_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.subjectId, table.subjectType] }),
  }),
);

export interface MaintenanceJobProgress {
  errorCount: number;
  lastError?: string;
  orphanPrefix?: string;
  orphanContinuationToken?: string;
  phase: "s3_derivatives" | "s3_originals" | "s3_orphan_sweep" | "db_hard_delete" | "completed";
  processedCount: number;
}

export const maintenanceJobs = pgTable(
  "maintenance_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: maintenanceJobTypeEnum("type").notNull(),
    status: maintenanceJobStatusEnum("status").notNull().default("pending"),
    progress: jsonb("progress").$type<MaintenanceJobProgress>().notNull().default({
      errorCount: 0,
      phase: "s3_derivatives",
      processedCount: 0,
    }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusIndex: index("maintenance_jobs_status_idx").on(table.status),
    typeStatusIndex: index("maintenance_jobs_type_status_idx").on(table.type, table.status),
  }),
);
