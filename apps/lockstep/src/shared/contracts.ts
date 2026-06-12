import { z } from "zod";

export const IpcErrorPayloadSchema = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("ValidationError"),
    message: z.string(),
    operation: z.string(),
    issues: z.array(z.string()).optional(),
  }),
  z.object({
    _tag: z.literal("FileSystemError"),
    message: z.string(),
    operation: z.string(),
    path: z.string().optional(),
  }),
  z.object({
    _tag: z.literal("ProtocolError"),
    channel: z.string(),
    message: z.string(),
  }),
  z.object({
    _tag: z.literal("RunError"),
    message: z.string(),
    operation: z.string(),
  }),
]);

export function createSerializedResultSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), value: valueSchema }),
    z.object({ status: z.literal("error"), error: IpcErrorPayloadSchema }),
  ]);
}

export const LockstepPlanCountsSchema = z.object({
  delete: z.number(),
  keep: z.number(),
  update: z.number(),
  upload: z.number(),
});

export const LockstepPlanItemSchema = z.object({
  action: z.enum(["delete", "keep", "update", "upload"]),
  path: z.string(),
});

export const LockstepPlanSchema = z.object({
  counts: LockstepPlanCountsSchema,
  items: z.array(LockstepPlanItemSchema),
  skipped: z.number(),
  skippedEntries: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
  sourceRoot: z.string(),
  totalBytes: z.number(),
  totalFiles: z.number(),
});

export const LockstepRunSummarySchema = z.object({
  action: z.enum(["doctor", "plan", "prune", "push"]),
  completedAt: z.string(),
  failed: z.number(),
  message: z.string().optional(),
  planCounts: LockstepPlanCountsSchema.optional(),
  profileId: z.string().optional(),
  pushed: z.number(),
  status: z.enum(["cancelled", "completed", "failed"]),
});

export const LockstepRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancelled") }),
  z.object({ type: z.literal("complete"), summary: LockstepRunSummarySchema }),
  z.object({
    type: z.literal("item-failure"),
    action: z.string(),
    current: z.number(),
    error: z.string(),
    path: z.string(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("item-success"),
    action: z.string(),
    current: z.number(),
    path: z.string(),
    total: z.number(),
  }),
  z.object({
    type: z.literal("scan-progress"),
    progress: z.object({
      filesFound: z.number(),
      skipped: z.number(),
      stage: z.enum(["hashing", "scanning"]),
      bytesHashed: z.number().optional(),
      fileSize: z.number().optional(),
      path: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("status"), message: z.string() }),
]);

export const LockstepProfilePublicSchema = z.object({
  apiUrl: z.string(),
  id: z.string(),
  lastRun: LockstepRunSummarySchema.optional(),
  name: z.string(),
  sourceRoot: z.string(),
  tokenConfigured: z.boolean(),
  tokenInSession: z.boolean(),
  tokenUnreadable: z.boolean(),
});

export const LockstepProfileInputSchema = z.object({
  apiUrl: z.string().min(1),
  name: z.string().min(1),
  sourceRoot: z.string().min(1),
  token: z.string().optional(),
});

export const LockstepProfilePatchSchema = z.object({
  apiUrl: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  sourceRoot: z.string().min(1).optional(),
  token: z.string().optional(),
});

export const LockstepSettingsSchema = z.object({
  activeProfileId: z.string().nullable(),
  profiles: z.array(LockstepProfilePublicSchema),
});

export const DoctorCheckSchema = z.object({
  detail: z.string().optional(),
  label: z.string(),
  ok: z.boolean(),
});

export const DoctorResultSchema = z.object({
  checks: z.array(DoctorCheckSchema),
  ok: z.boolean(),
});

export const RunRequestSchema = z.object({
  hashFiles: z.boolean().optional(),
  maxChanges: z.number().int().positive().optional(),
  profileId: z.string(),
});
