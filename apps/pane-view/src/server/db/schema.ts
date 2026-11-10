import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
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
import type { JsonValue } from "@/lib/json";
import {
  ACTIVE_MAINTENANCE_JOB_STATUSES,
  MAINTENANCE_JOB_STATUSES,
  MAINTENANCE_JOB_TYPES,
  SYNC_RUN_STATUSES,
} from "@/lib/library-jobs";

export const mediaTypeEnum = pgEnum("media_type", ["image", "gif", "video", "pdf", "unknown"]);

export const syncRunStatusEnum = pgEnum("sync_run_status", SYNC_RUN_STATUSES);

export const syncActionEnum = pgEnum("sync_action", ["upload", "delete"]);

export const maintenanceJobTypeEnum = pgEnum("maintenance_job_type", MAINTENANCE_JOB_TYPES);

export const maintenanceJobStatusEnum = pgEnum("maintenance_job_status", MAINTENANCE_JOB_STATUSES);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().default("Pane View Owner"),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("sessions_token_unique").on(table.token),
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

export const loginThrottleAttempts = pgTable(
  "login_throttle_attempts",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresAtIndex: index("login_throttle_attempts_expires_at_idx").on(table.expiresAt),
  }),
);

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sourceRoot: text("source_root").notNull(),
  status: syncRunStatusEnum("status").notNull(),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  error: text("error"),
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
    objectKey: text("object_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sha256SizeUnique: uniqueIndex("media_objects_sha256_size_unique").on(table.sha256, table.size),
    // One spelling per hash, so equality on sha256 matches the same bytes (migration 0021).
    sha256Lowercase: check(
      "media_objects_sha256_lowercase",
      sql`${table.sha256} = lower(${table.sha256})`,
    ),
  }),
);

export const shutterSourceCleanup = pgTable(
  "shutter_source_cleanup",
  {
    sha256: text("sha256").primaryKey(),
    /** The original's key, so a v2 resolver source can be purged after the media row is gone. */
    objectKey: text("object_key"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => ({
    pendingIndex: index("shutter_source_cleanup_pending_idx")
      .on(table.queuedAt)
      .where(sql`${table.purgedAt} is null`),
    sha256Lowercase: check(
      "shutter_source_cleanup_sha256_lowercase",
      sql`${table.sha256} = lower(${table.sha256})`,
    ),
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
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    logicalPathUnique: uniqueIndex("library_entries_logical_path_unique").on(table.logicalPath),
    parentIndex: index("library_entries_parent_path_idx").on(table.parentPath),
    mediaObjectIndex: index("library_entries_media_object_id_idx").on(table.mediaObjectId),
    deletedAtIndex: index("library_entries_deleted_at_idx").on(table.deletedAt),
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
    action: syncActionEnum("action").notNull(),
    error: text("error"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.syncRunId, table.logicalPath] }),
    // Backs the ON DELETE SET NULL foreign key so a media delete doesn't scan the table.
    mediaObjectIndex: index("sync_run_items_media_object_id_idx").on(table.mediaObjectId),
  }),
);

export const viewerState = pgTable(
  "viewer_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => libraryEntries.id, { onDelete: "cascade" }),
    positionMs: integer("position_ms"),
    page: integer("page"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.subjectId] }),
  }),
);

/** The partial unique index that allows one active job per type. */
export const ACTIVE_MAINTENANCE_JOB_INDEX = "maintenance_jobs_active_type_unique";

const activeStatusList = sql.raw(
  ACTIVE_MAINTENANCE_JOB_STATUSES.map((status) => `'${status}'`).join(", "),
);

export const maintenanceJobs = pgTable(
  "maintenance_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: maintenanceJobTypeEnum("type").notNull(),
    status: maintenanceJobStatusEnum("status").notNull().default("pending"),
    // Parsed per job type by parseMaintenanceProgress (lib/library-jobs.ts).
    progress: jsonb("progress").$type<JsonValue>().notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusIndex: index("maintenance_jobs_status_idx").on(table.status),
    typeStatusIndex: index("maintenance_jobs_type_status_idx").on(table.type, table.status),
    activeTypeUnique: uniqueIndex(ACTIVE_MAINTENANCE_JOB_INDEX)
      .on(table.type)
      .where(sql`${table.status} in (${activeStatusList})`),
  }),
);
