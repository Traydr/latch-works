import * as z from "zod/mini";
import { DownloadFailureSchema, GatherFolderScopeSchema, RunLogEntrySchema } from "../gather-run";
import { type ChannelFailure, failChannel, sendChannelRequest } from "../messaging";
import { DownloadableFileSchema } from "../types";

/** Offscreen document to service worker: what an executing run reports. */

export const GATHER_RUN_EVENT = "GATHER_BOX_RUN_EVENT";

const GatherRunEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission-required"),
    scope: GatherFolderScopeSchema,
    /** Set by the background when several profiles exist, so the panel can name the one to use. */
    profileName: z.optional(z.string()),
  }),
  z.object({
    kind: z.literal("writing"),
    destinationPreview: z.string(),
    folderSegments: z.array(z.string()),
    total: z.number(),
  }),
  z.object({
    kind: z.literal("progress"),
    completed: z.number(),
    total: z.number(),
    message: z.string(),
  }),
  z.extend(RunLogEntrySchema, { kind: z.literal("log") }),
  z.object({
    kind: z.literal("complete"),
    saved: z.number(),
    skipped: z.number(),
    failed: z.number(),
    failedItems: z.array(DownloadFailureSchema),
    retryImages: z.array(DownloadableFileSchema),
  }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("cancelled"), message: z.optional(z.string()) }),
]);

export type GatherRunEvent = z.infer<typeof GatherRunEventSchema>;

export const GatherRunEventMessageSchema = z.object({
  type: z.literal(GATHER_RUN_EVENT),
  target: z.literal("background"),
  runId: z.string(),
  event: GatherRunEventSchema,
});

export type GatherRunEventMessage = z.infer<typeof GatherRunEventMessageSchema>;

export function gatherRunEventMessage(runId: string, event: GatherRunEvent): GatherRunEventMessage {
  return { type: GATHER_RUN_EVENT, target: "background", runId, event };
}

export interface RunEventResponses {
  /** Answered once the background persisted the event. */
  [GATHER_RUN_EVENT]: { outcome: "accepted" };
}

export function sendGatherRunEvent(
  runId: string,
  event: GatherRunEvent,
): Promise<RunEventResponses[typeof GATHER_RUN_EVENT] | ChannelFailure> {
  return sendChannelRequest(gatherRunEventMessage(runId, event), failChannel);
}

export function isTerminalGatherRunEvent(event: GatherRunEvent): boolean {
  return event.kind === "complete" || event.kind === "failed" || event.kind === "cancelled";
}

/**
 * Reports that end a run's hold on the queue: a terminal event, or the permission pause that leaves
 * the job waiting for folder access. The background dispatches the next queued output from these.
 */
export function releasesGatherQueue(event: GatherRunEvent): boolean {
  return isTerminalGatherRunEvent(event) || event.kind === "permission-required";
}
