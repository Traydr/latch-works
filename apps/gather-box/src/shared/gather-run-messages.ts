import type { GatherRunState, GatherRunStartOutcome } from "./gather-run";
import type { GatherBoxSettings } from "./settings";
import type { DownloadablePayload, GeneratedStoryPayload } from "./types";

export const START_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_START" as const;
export const RETRY_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_RETRY" as const;
export const EXECUTE_GATHER_RUN = "GATHER_BOX_RUN_EXECUTE" as const;
export const GATHER_RUN_EVENT = "GATHER_BOX_RUN_EVENT" as const;

export interface StartGatherRunRequest {
  type: typeof START_GATHER_RUN_REQUEST;
  target: "background";
  tabId: number;
}

export interface RetryGatherRunRequest {
  type: typeof RETRY_GATHER_RUN_REQUEST;
  target: "background";
  runId: string;
}

export interface ExecuteGatherRunMessage {
  type: typeof EXECUTE_GATHER_RUN;
  target: "offscreen";
  runId: string;
  payload: DownloadablePayload | GeneratedStoryPayload;
  settings: GatherBoxSettings;
}

export type GatherRunEvent =
  | { kind: "permission-required" }
  | { kind: "writing"; destinationPreview: string; folderSegments: string[]; total: number }
  | { kind: "progress"; completed: number; total: number; message: string }
  | { kind: "log"; message: string; tone?: "error" | "success" }
  | {
      kind: "complete";
      saved: number;
      skipped: number;
      failed: number;
      failedItems: GatherRunState["failedItems"];
      retryImages: GatherRunState["retryImages"];
    }
  | { kind: "failed"; message: string };

export interface GatherRunEventMessage {
  type: typeof GATHER_RUN_EVENT;
  target: "background";
  runId: string;
  event: GatherRunEvent;
}

export type GatherRunResponse = GatherRunStartOutcome;

export function isStartGatherRunRequest(value: unknown): value is StartGatherRunRequest {
  return hasMessageShape(value, START_GATHER_RUN_REQUEST, "background") && typeof value.tabId === "number";
}

export function isRetryGatherRunRequest(value: unknown): value is RetryGatherRunRequest {
  return hasMessageShape(value, RETRY_GATHER_RUN_REQUEST, "background") && typeof value.runId === "string";
}

export function isExecuteGatherRunMessage(value: unknown): value is ExecuteGatherRunMessage {
  return hasMessageShape(value, EXECUTE_GATHER_RUN, "offscreen") && typeof value.runId === "string" && "payload" in value;
}

export function isGatherRunEventMessage(value: unknown): value is GatherRunEventMessage {
  return hasMessageShape(value, GATHER_RUN_EVENT, "background") && typeof value.runId === "string" && "event" in value;
}

function hasMessageShape<TType extends string, TTarget extends string>(
  value: unknown,
  type: TType,
  target: TTarget
): value is Record<string, unknown> & { type: TType; target: TTarget } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === type &&
    "target" in value &&
    value.target === target
  );
}
