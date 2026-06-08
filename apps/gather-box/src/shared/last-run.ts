import type { LogTone } from "../popup/dom";

export interface DownloadFailure {
  fileName: string;
  reason: string;
  originalUrl?: string;
}
import type { SiteKey } from "./sites";
import type { GalleryImage } from "./types";

export interface LastRunLogEntry {
  message: string;
  tone?: LogTone;
}

export interface LastRunState {
  timestamp: number;
  siteKey: SiteKey | null;
  tabUrl: string | null;
  destinationPreview: string | null;
  log: LastRunLogEntry[];
  failedItems: DownloadFailure[];
  retryImages: GalleryImage[];
  canRetry: boolean;
}

const LAST_RUN_KEY = "gather-box-last-run";

export const EMPTY_LAST_RUN: LastRunState = {
  timestamp: 0,
  siteKey: null,
  tabUrl: null,
  destinationPreview: null,
  log: [],
  failedItems: [],
  retryImages: [],
  canRetry: false
};

export async function loadLastRun(): Promise<LastRunState> {
  const stored = await chrome.storage.local.get(LAST_RUN_KEY);
  const value = stored[LAST_RUN_KEY];

  if (!value || typeof value !== "object") {
    return { ...EMPTY_LAST_RUN };
  }

  return normalizeLastRun(value as Partial<LastRunState>);
}

export async function saveLastRun(state: LastRunState): Promise<void> {
  await chrome.storage.local.set({ [LAST_RUN_KEY]: normalizeLastRun(state) });
}

export async function clearLastRun(): Promise<void> {
  await chrome.storage.local.remove(LAST_RUN_KEY);
}

function normalizeLastRun(state: Partial<LastRunState>): LastRunState {
  return {
    timestamp: Number(state.timestamp) || 0,
    siteKey: state.siteKey ?? null,
    tabUrl: typeof state.tabUrl === "string" ? state.tabUrl : null,
    destinationPreview:
      typeof state.destinationPreview === "string" ? state.destinationPreview : null,
    log: Array.isArray(state.log)
      ? state.log
          .filter((entry) => entry && typeof entry.message === "string")
          .map((entry) => ({
            message: entry.message,
            tone: entry.tone === "error" || entry.tone === "success" ? entry.tone : undefined
          }))
      : [],
    failedItems: Array.isArray(state.failedItems)
      ? state.failedItems.filter(
          (item) => item && typeof item.fileName === "string" && typeof item.reason === "string"
        )
      : [],
    retryImages: Array.isArray(state.retryImages)
      ? state.retryImages.filter(
          (item) =>
            item &&
            typeof item.fileName === "string" &&
            typeof item.originalUrl === "string" &&
            typeof item.pageNumber === "number"
        )
      : [],
    canRetry: Boolean(state.canRetry)
  };
}
