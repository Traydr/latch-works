import { z } from "zod";
import type { GatherRunStartOutcome, GatherRunState } from "./gather-run";
import { DownloadFailureSchema, LastRunLogEntrySchema } from "./last-run";
import { GatherBoxSettingsSchema } from "./settings";
import {
  DownloadablePayloadSchema,
  GalleryImageSchema,
  GeneratedStoryPayloadSchema
} from "./types";

export const START_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_START" as const;
export const RETRY_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_RETRY" as const;
export const CANCEL_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_CANCEL" as const;
export const EXECUTE_GATHER_RUN = "GATHER_BOX_RUN_EXECUTE" as const;
export const CANCEL_GATHER_RUN = "GATHER_BOX_RUN_ABORT" as const;
export const GATHER_RUN_EVENT = "GATHER_BOX_RUN_EVENT" as const;
export const GET_GATHER_EXECUTOR_STATUS = "GATHER_BOX_EXECUTOR_STATUS" as const;

export const StartGatherRunRequestSchema = z.object({
  type: z.literal(START_GATHER_RUN_REQUEST),
  target: z.literal("background"),
  tabId: z.number()
});

export type StartGatherRunRequest = z.infer<typeof StartGatherRunRequestSchema>;

export const RetryGatherRunRequestSchema = z.object({
  type: z.literal(RETRY_GATHER_RUN_REQUEST),
  target: z.literal("background"),
  runId: z.string()
});

export type RetryGatherRunRequest = z.infer<typeof RetryGatherRunRequestSchema>;

export const CancelGatherRunRequestSchema = z.object({
  type: z.literal(CANCEL_GATHER_RUN_REQUEST),
  target: z.literal("background"),
  runId: z.string()
});

export type CancelGatherRunRequest = z.infer<typeof CancelGatherRunRequestSchema>;

export const ExecuteGatherRunMessageSchema = z.object({
  type: z.literal(EXECUTE_GATHER_RUN),
  target: z.literal("offscreen"),
  runId: z.string(),
  payload: z.union([DownloadablePayloadSchema, GeneratedStoryPayloadSchema]),
  settings: GatherBoxSettingsSchema
});

export type ExecuteGatherRunMessage = z.infer<typeof ExecuteGatherRunMessageSchema>;

export const CancelGatherRunMessageSchema = z.object({
  type: z.literal(CANCEL_GATHER_RUN),
  target: z.literal("offscreen"),
  runId: z.string()
});

export type CancelGatherRunMessage = z.infer<typeof CancelGatherRunMessageSchema>;

export const GetGatherExecutorStatusMessageSchema = z.object({
  type: z.literal(GET_GATHER_EXECUTOR_STATUS),
  target: z.literal("offscreen")
});

export type GetGatherExecutorStatusMessage = z.infer<typeof GetGatherExecutorStatusMessageSchema>;

/** Which folder handle a paused job is waiting on, so the panel can say where to confirm it. */
export const GatherFolderScopeSchema = z.enum(["global", "site"]);
export type GatherFolderScope = z.infer<typeof GatherFolderScopeSchema>;

export const GatherRunEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission-required"), scope: GatherFolderScopeSchema }),
  z.object({
    kind: z.literal("writing"),
    destinationPreview: z.string(),
    folderSegments: z.array(z.string()),
    total: z.number()
  }),
  z.object({
    kind: z.literal("progress"),
    completed: z.number(),
    total: z.number(),
    message: z.string()
  }),
  LastRunLogEntrySchema.extend({ kind: z.literal("log") }),
  z.object({
    kind: z.literal("complete"),
    saved: z.number(),
    skipped: z.number(),
    failed: z.number(),
    failedItems: z.array(DownloadFailureSchema),
    retryImages: z.array(GalleryImageSchema)
  }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("cancelled"), message: z.string().optional() })
]);

export type GatherRunEvent = z.infer<typeof GatherRunEventSchema>;

export const GatherRunEventMessageSchema = z.object({
  type: z.literal(GATHER_RUN_EVENT),
  target: z.literal("background"),
  runId: z.string(),
  event: GatherRunEventSchema
});

export type GatherRunEventMessage = z.infer<typeof GatherRunEventMessageSchema>;

export type GatherRunResponse = GatherRunStartOutcome;

export type GatherRunCancelOutcome =
  | { outcome: "cancelled"; run: GatherRunState }
  | { outcome: "idle" }
  | { outcome: "failed"; message: string };

/** Events that end a run. The background dispatches the next queued output from exactly these. */
export function isTerminalGatherRunEvent(event: GatherRunEvent): boolean {
  return event.kind === "complete" || event.kind === "failed" || event.kind === "cancelled";
}
