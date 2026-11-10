import * as z from "zod/mini";
import { type ChannelFailure, failChannel, sendChannelRequest } from "../messaging";
import { GatherBoxSettingsSchema } from "../settings";
import { GatherOutputSchema } from "../types";

/** Service worker to offscreen document: the executor that writes one output at a time. */

export const EXECUTE_GATHER_RUN = "GATHER_BOX_RUN_EXECUTE";

export const CANCEL_GATHER_RUN = "GATHER_BOX_RUN_ABORT";

export const GET_GATHER_EXECUTOR_STATUS = "GATHER_BOX_EXECUTOR_STATUS";

const ExecuteGatherRunMessageSchema = z.object({
  type: z.literal(EXECUTE_GATHER_RUN),
  target: z.literal("offscreen"),
  runId: z.string(),
  payload: GatherOutputSchema,
  settings: GatherBoxSettingsSchema,
  destinationId: z.nullable(z.string()),
  profileId: z.string(),
});

export type ExecuteGatherRunMessage = z.infer<typeof ExecuteGatherRunMessageSchema>;

export const ExecutorRequestSchema = z.discriminatedUnion("type", [
  ExecuteGatherRunMessageSchema,
  z.object({
    type: z.literal(CANCEL_GATHER_RUN),
    target: z.literal("offscreen"),
    runId: z.string(),
  }),
  z.object({ type: z.literal(GET_GATHER_EXECUTOR_STATUS), target: z.literal("offscreen") }),
]);

export type ExecutorRequest = z.infer<typeof ExecutorRequestSchema>;

export interface ExecutorResponses {
  /** `busy` while another run holds the execution slot. */
  [EXECUTE_GATHER_RUN]: { outcome: "accepted" } | { outcome: "busy" };
  [CANCEL_GATHER_RUN]: { aborted: boolean };
  /** The offscreen document runs at most one Gather Run at a time. */
  [GET_GATHER_EXECUTOR_STATUS]: { activeRunId: string | null };
}

export function sendExecutorRequest<Request extends ExecutorRequest>(
  request: Request,
): Promise<ExecutorResponses[Request["type"]] | ChannelFailure> {
  return sendChannelRequest(request, failChannel);
}
