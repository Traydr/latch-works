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

export const mediaTypeEnum = pgEnum("media_type", ["image", "video", "story"]);
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

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
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
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    userIdIndex: index("sessions_user_id_idx").on(table.userId),
  }),
);

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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sha256Unique: uniqueIndex("media_objects_sha256_unique").on(table.sha256),
  }),
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    path: text("path").notNull(),
    parentPath: text("parent_path").notNull().default(""),
    name: text("name").notNull(),
    entryCount: integer("entry_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pathUnique: uniqueIndex("folders_path_unique").on(table.path),
    parentIndex: index("folders_parent_path_idx").on(table.parentPath),
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
    source: text("source"),
    sourceId: text("source_id"),
    hidden: boolean("hidden").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    logicalPathUnique: uniqueIndex("library_entries_logical_path_unique").on(table.logicalPath),
    parentIndex: index("library_entries_parent_path_idx").on(table.parentPath),
    mediaObjectIndex: index("library_entries_media_object_id_idx").on(table.mediaObjectId),
  }),
);

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: collectionTypeEnum("type").notNull(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    coverEntryId: uuid("cover_entry_id").references(() => libraryEntries.id, {
      onDelete: "set null",
    }),
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
    status: text("status").notNull().default("ready"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.mediaObjectId, table.size] }),
  }),
);

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sourceRoot: text("source_root").notNull(),
  status: syncRunStatusEnum("status").notNull(),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  manifestKey: text("manifest_key"),
});

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
  }),
);

export const viewerState = pgTable(
  "viewer_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id").notNull(),
    subjectType: text("subject_type").notNull(),
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
    subjectType: text("subject_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.subjectId, table.subjectType] }),
  }),
);
