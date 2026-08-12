import type { GatherRunState, GatherRunStartOutcome } from "./gather-run";
import type { GatherBoxSettings } from "./settings";
import type { DownloadablePayload, GeneratedStoryPayload } from "./types";

export const START_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_START" as const;
export const RETRY_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_RETRY" as const;
export const CANCEL_GATHER_RUN_REQUEST = "GATHER_BOX_RUN_CANCEL" as const;
export const EXECUTE_GATHER_RUN = "GATHER_BOX_RUN_EXECUTE" as const;
export const CANCEL_GATHER_RUN = "GATHER_BOX_RUN_ABORT" as const;
export const GATHER_RUN_EVENT = "GATHER_BOX_RUN_EVENT" as const;
export const GET_GATHER_EXECUTOR_STATUS = "GATHER_BOX_EXECUTOR_STATUS" as const;

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

export interface CancelGatherRunRequest {
  type: typeof CANCEL_GATHER_RUN_REQUEST;
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

export interface CancelGatherRunMessage {
  type: typeof CANCEL_GATHER_RUN;
  target: "offscreen";
  runId: string;
}

export interface GetGatherExecutorStatusMessage {
  type: typeof GET_GATHER_EXECUTOR_STATUS;
  target: "offscreen";
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
  | { kind: "failed"; message: string }
  | { kind: "cancelled"; message?: string };

export interface GatherRunEventMessage {
  type: typeof GATHER_RUN_EVENT;
  target: "background";
  runId: string;
  event: GatherRunEvent;
}

export type GatherRunResponse = GatherRunStartOutcome;

export type GatherRunCancelOutcome =
  | { outcome: "cancelled"; run: GatherRunState }
  | { outcome: "idle" }
  | { outcome: "failed"; message: string };

export function isStartGatherRunRequest(value: unknown): value is StartGatherRunRequest {
  return hasMessageShape(value, START_GATHER_RUN_REQUEST, "background") && typeof value.tabId === "number";
}

export function isRetryGatherRunRequest(value: unknown): value is RetryGatherRunRequest {
  return hasMessageShape(value, RETRY_GATHER_RUN_REQUEST, "background") && typeof value.runId === "string";
}

export function isCancelGatherRunRequest(value: unknown): value is CancelGatherRunRequest {
  return hasMessageShape(value, CANCEL_GATHER_RUN_REQUEST, "background") && typeof value.runId === "string";
}

export function isExecuteGatherRunMessage(value: unknown): value is ExecuteGatherRunMessage {
  return (
    hasMessageShape(value, EXECUTE_GATHER_RUN, "offscreen") &&
    typeof value.runId === "string" &&
    "payload" in value &&
    "settings" in value
  );
}

export function isCancelGatherRunMessage(value: unknown): value is CancelGatherRunMessage {
  return hasMessageShape(value, CANCEL_GATHER_RUN, "offscreen") && typeof value.runId === "string";
}

export function isGetGatherExecutorStatusMessage(
  value: unknown
): value is GetGatherExecutorStatusMessage {
  return hasMessageShape(value, GET_GATHER_EXECUTOR_STATUS, "offscreen");
}

export function isGatherRunEventMessage(value: unknown): value is GatherRunEventMessage {
  return (
    hasMessageShape(value, GATHER_RUN_EVENT, "background") &&
    typeof value.runId === "string" &&
    "event" in value &&
    isGatherRunEvent(value.event)
  );
}

export function isGatherRunEvent(value: unknown): value is GatherRunEvent {
  if (!value || typeof value !== "object" || !("kind" in value)) {
    return false;
  }

  const event = value as Record<string, unknown>;
  switch (event.kind) {
    case "permission-required":
      return true;
    case "writing":
      return (
        typeof event.destinationPreview === "string" &&
        Array.isArray(event.folderSegments) &&
        event.folderSegments.every((segment) => typeof segment === "string") &&
        typeof event.total === "number"
      );
    case "progress":
      return (
        typeof event.completed === "number" &&
        typeof event.total === "number" &&
        typeof event.message === "string"
      );
    case "log":
      return (
        typeof event.message === "string" &&
        (event.tone === undefined || event.tone === "error" || event.tone === "success")
      );
    case "complete":
      return (
        typeof event.saved === "number" &&
        typeof event.skipped === "number" &&
        typeof event.failed === "number" &&
        Array.isArray(event.failedItems) &&
        Array.isArray(event.retryImages)
      );
    case "failed":
      return typeof event.message === "string";
    case "cancelled":
      return event.message === undefined || typeof event.message === "string";
    default:
      return false;
  }
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
