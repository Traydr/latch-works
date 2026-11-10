/*
 * The sync API Pane View serves and the Lockstep clients call: each body a client posts and each
 * answer it reads, as the client sends and reads it. Pane View parses the same bodies by extending
 * these shapes with its own checks and error messages (stricter fields, the archive media type,
 * optional fields it derives). Oriel's Rust client generates its types from these schemas through
 * apps/oriel/conformance/lockstep-core/api-schema.json, which `api-schema.test.ts` writes.
 */
import { z } from "zod";
import { ArchiveMediaTypeSchema } from "./objects.js";

export const SYNC_ROUTES = {
  completeObject: "/api/sync/complete-object",
  runs: "/api/sync/runs",
  snapshot: "/api/sync/snapshot",
  uploadUrl: "/api/sync/upload-url",
} as const;

export function completeSyncRunRoute(syncRunId: string): string {
  return `${SYNC_ROUTES.runs}/${syncRunId}/complete`;
}

/** A plan's counts per action, which a sync run records when it starts. */
export const SyncPlanCountsSchema = z.object({
  delete: z.number(),
  keep: z.number(),
  update: z.number(),
  upload: z.number(),
});

export type SyncPlanCounts = z.infer<typeof SyncPlanCountsSchema>;

export const CreateSyncRunRequestSchema = z.object({
  counts: SyncPlanCountsSchema,
  sourceRoot: z.string(),
});

export type CreateSyncRunRequest = z.infer<typeof CreateSyncRunRequestSchema>;

/**
 * What a run did, recorded when it ends: the plan's counts, how many changes it planned and took
 * on after the cap, and how many of those it applied (`pushed`, for prune's deletes too) or failed.
 */
export const SyncRunOutcomeCountsSchema = SyncPlanCountsSchema.extend({
  capped: z.number(),
  failed: z.number(),
  planned: z.number(),
  pushed: z.number(),
});

/** How a run ended. */
export const SyncRunStatusSchema = z.enum(["cancelled", "completed", "failed"]);

export type SyncRunStatus = z.infer<typeof SyncRunStatusSchema>;

export const CompleteSyncRunRequestSchema = z.object({
  counts: SyncRunOutcomeCountsSchema,
  error: z.string().optional(),
  status: SyncRunStatusSchema,
});

export type CompleteSyncRunRequest = z.infer<typeof CompleteSyncRunRequestSchema>;

export const UploadUrlRequestSchema = z.object({
  contentType: z.string(),
  filename: z.string(),
  sha256: z.string(),
  size: z.number(),
});

export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

/** Registers an uploaded original at a library path. */
export const CompleteObjectRequestSchema = z.object({
  contentType: z.string(),
  extension: z.string(),
  filename: z.string(),
  logicalPath: z.string(),
  mediaType: ArchiveMediaTypeSchema,
  mtimeMs: z.number(),
  objectKey: z.string(),
  sha256: z.string(),
  size: z.number(),
  syncRunId: z.string(),
});

export type CompleteObjectRequest = z.infer<typeof CompleteObjectRequestSchema>;

export const DeleteObjectRequestSchema = z.object({
  action: z.literal("delete"),
  logicalPath: z.string(),
  syncRunId: z.string(),
});

export type DeleteObjectRequest = z.infer<typeof DeleteObjectRequestSchema>;

export const SyncRunSchema = z.object({ syncRunId: z.string() });

/** Where to PUT an original. */
export const UploadTargetSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  objectKey: z.string(),
  uploadUrl: z.string(),
});

/** One library entry in the snapshot. A non-string `sha256` is dropped rather than rejected. */
export const RemoteEntrySchema = z.object({
  path: z.string(),
  sha256: z.string().optional().catch(undefined),
  size: z.number(),
});

export type RemoteEntry = z.infer<typeof RemoteEntrySchema>;

/** What `GET /api/sync/snapshot` answers, as far as a client reads it. */
export const RemoteSnapshotResponseSchema = z.object({ entries: z.array(RemoteEntrySchema) });
