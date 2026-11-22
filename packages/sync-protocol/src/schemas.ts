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
  mediaFacts: "/api/sync/media-facts",
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
  /**
   * A video's audio: whether it has at least one audio stream. Absent for other media, and for a
   * video the client could not probe; Pane View then keeps whatever it already knew.
   */
  hasAudio: z.boolean().optional(),
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

/**
 * What a client learned about an original's content that its type does not say, keyed by the
 * bytes: today whether a video has audio. Clients report it for videos already synced before the
 * fact was recorded, so Pane View learns it without the upload being repeated.
 */
export const MediaFactSchema = z.object({
  hasAudio: z.boolean(),
  sha256: z.string(),
  size: z.number(),
});

export type MediaFact = z.infer<typeof MediaFactSchema>;

/** Most facts one `POST /api/sync/media-facts` may carry. */
export const MAX_MEDIA_FACTS_PER_REQUEST = 500;

export const ReportMediaFactsRequestSchema = z.object({
  facts: z.array(MediaFactSchema).max(MAX_MEDIA_FACTS_PER_REQUEST),
});

export type ReportMediaFactsRequest = z.infer<typeof ReportMediaFactsRequestSchema>;

/**
 * One library entry in the snapshot. A non-string `sha256` is dropped rather than rejected.
 * `hasAudio` is present only for a video whose audio Pane View knows; a client reports the facts
 * of the videos it lacks.
 */
export const RemoteEntrySchema = z.object({
  hasAudio: z.boolean().optional().catch(undefined),
  path: z.string(),
  sha256: z.string().optional().catch(undefined),
  size: z.number(),
});

export type RemoteEntry = z.infer<typeof RemoteEntrySchema>;

/** What `GET /api/sync/snapshot` answers, as far as a client reads it. */
export const RemoteSnapshotResponseSchema = z.object({ entries: z.array(RemoteEntrySchema) });
