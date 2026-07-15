import type { DownloadFailure, LastRunLogEntry } from "./last-run";
import type { SiteKey } from "./sites";
import type { GalleryImage } from "./types";

export const GATHER_RUN_STATE_KEY = "gather-box-active-run";
export const GATHER_RUN_SCHEMA_VERSION = 1;

export type GatherRunPhase =
  | "preparing"
  | "permission-required"
  | "collecting"
  | "writing"
  | "complete"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface GatherRunProgress {
  completed: number;
  total: number;
  saved: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface GatherRunState {
  schemaVersion: typeof GATHER_RUN_SCHEMA_VERSION;
  id: string;
  tabId: number;
  windowId: number;
  tabUrl: string;
  siteKey: SiteKey;
  createdAt: number;
  updatedAt: number;
  phase: GatherRunPhase;
  progress: GatherRunProgress;
  log: LastRunLogEntry[];
  destinationPreview: string | null;
  folderSegments: string[];
  failedItems: DownloadFailure[];
  retryImages: GalleryImage[];
  error: string | null;
}

export type GatherRunStartOutcome =
  | { outcome: "started"; run: GatherRunState }
  | { outcome: "already-running"; run: GatherRunState }
  | { outcome: "unsupported-source" }
  | { outcome: "target-unavailable" }
  | { outcome: "failed"; message: string };

export function isTerminalGatherRunPhase(phase: GatherRunPhase): boolean {
  return phase === "complete" || phase === "failed" || phase === "cancelled" || phase === "interrupted";
}

export function createGatherRunState(input: {
  id: string;
  tabId: number;
  windowId: number;
  tabUrl: string;
  siteKey: SiteKey;
  now?: number;
}): GatherRunState {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: GATHER_RUN_SCHEMA_VERSION,
    id: input.id,
    tabId: input.tabId,
    windowId: input.windowId,
    tabUrl: input.tabUrl,
    siteKey: input.siteKey,
    createdAt: now,
    updatedAt: now,
    phase: "preparing",
    progress: {
      completed: 0,
      total: 0,
      saved: 0,
      skipped: 0,
      failed: 0,
      message: "Preparing Gather Run..."
    },
    log: [],
    destinationPreview: null,
    folderSegments: [],
    failedItems: [],
    retryImages: [],
    error: null
  };
}

export function normalizeGatherRunState(value: unknown): GatherRunState | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const run = value as Partial<GatherRunState>;
  if (
    run.schemaVersion !== GATHER_RUN_SCHEMA_VERSION ||
    typeof run.id !== "string" ||
    typeof run.tabId !== "number" ||
    typeof run.windowId !== "number" ||
    typeof run.tabUrl !== "string" ||
    typeof run.siteKey !== "string" ||
    typeof run.createdAt !== "number" ||
    typeof run.updatedAt !== "number" ||
    !isGatherRunPhase(run.phase)
  ) {
    return null;
  }

  return {
    ...createGatherRunState({
      id: run.id,
      tabId: run.tabId,
      windowId: run.windowId,
      tabUrl: run.tabUrl,
      siteKey: run.siteKey as SiteKey,
      now: run.createdAt
    }),
    ...run,
    progress: {
      completed: Number(run.progress?.completed) || 0,
      total: Number(run.progress?.total) || 0,
      saved: Number(run.progress?.saved) || 0,
      skipped: Number(run.progress?.skipped) || 0,
      failed: Number(run.progress?.failed) || 0,
      message: typeof run.progress?.message === "string" ? run.progress.message : ""
    },
    log: Array.isArray(run.log) ? run.log : [],
    folderSegments: Array.isArray(run.folderSegments)
      ? run.folderSegments.filter((segment): segment is string => typeof segment === "string")
      : [],
    failedItems: Array.isArray(run.failedItems) ? run.failedItems : [],
    retryImages: Array.isArray(run.retryImages) ? run.retryImages : [],
    destinationPreview:
      typeof run.destinationPreview === "string" ? run.destinationPreview : null,
    error: typeof run.error === "string" ? run.error : null
  };
}

function isGatherRunPhase(value: unknown): value is GatherRunPhase {
  return (
    value === "preparing" ||
    value === "permission-required" ||
    value === "collecting" ||
    value === "writing" ||
    value === "complete" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}
