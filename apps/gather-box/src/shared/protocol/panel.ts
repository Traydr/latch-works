import * as z from "zod/mini";
import type { GatherRunCancelOutcome, GatherRunStartOutcome } from "../gather-run";
import { type ChannelFailure, failChannel, sendChannelRequest } from "../messaging";

/** Side panel to service worker: the run owner's control surface. */

export const START_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_START";

export const RETRY_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_RETRY";

export const CANCEL_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_CANCEL";

export const HAND_BACK_GATHER_FILE_REQUEST = "GATHER_BOX_RUN_HAND_BACK";

export const PanelRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(START_GATHER_RUN_REQUEST),
    target: z.literal("background"),
    tabId: z.number(),
    /** The profile whose folder the side panel just confirmed. Without it, the active one is used. */
    profileId: z.optional(z.string()),
  }),
  z.object({
    type: z.literal(RETRY_GATHER_RUN_REQUEST),
    target: z.literal("background"),
    runId: z.string(),
    /** The profile whose folder the side panel just confirmed. Without it, the active one is used. */
    profileId: z.optional(z.string()),
  }),
  z.object({
    type: z.literal(CANCEL_GATHER_RUN_REQUEST),
    target: z.literal("background"),
    runId: z.string(),
  }),
  /** Sent after the side panel saved a blocked file you downloaded yourself. */
  z.object({
    type: z.literal(HAND_BACK_GATHER_FILE_REQUEST),
    target: z.literal("background"),
    runId: z.string(),
    fileName: z.string(),
    savedFileName: z.string(),
  }),
]);

export type PanelRequest = z.infer<typeof PanelRequestSchema>;

/** `not-listed` when the run no longer lists the file as blocked, such as after a retry. */
type HandBackGatherFileOutcome = { outcome: "recorded" } | { outcome: "not-listed" };

export interface PanelResponses {
  [START_GATHER_RUN_REQUEST]: GatherRunStartOutcome;
  [RETRY_GATHER_RUN_REQUEST]: GatherRunStartOutcome;
  [CANCEL_GATHER_RUN_REQUEST]: GatherRunCancelOutcome;
  [HAND_BACK_GATHER_FILE_REQUEST]: HandBackGatherFileOutcome;
}

export function sendPanelRequest<Request extends PanelRequest>(
  request: Request,
): Promise<PanelResponses[Request["type"]] | ChannelFailure> {
  return sendChannelRequest(request, failChannel);
}
