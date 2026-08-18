import * as z from "zod/mini";
import type { DownloadFailure, LastRunLogEntry } from "./last-run";
import { DownloadFailureSchema, LastRunLogEntrySchema } from "./last-run";
import type { SiteKey } from "./sites";
import { SiteKeySchema } from "./source-catalog";
import { lenientArrayOf } from "./lenient-array";
import type { GalleryImage } from "./types";
import { DownloadableFileSchema } from "./types";

export const GATHER_RUN_SCHEMA_VERSION = 1;

export const GatherRunPhaseSchema = z.enum([
  "preparing",
  "permission-required",
  "collecting",
  "queued",
  "writing",
  "cancelling",
  "complete",
  "failed",
  "cancelled",
  "interrupted"
]);

export type GatherRunPhase = z.infer<typeof GatherRunPhaseSchema>;

export const GatherRunProgressSchema = z.object({
  completed: z.number(),
  total: z.number(),
  saved: z.number(),
  skipped: z.number(),
  failed: z.number(),
  message: z.string()
});

export type GatherRunProgress = z.infer<typeof GatherRunProgressSchema>;

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
  queuedCount: number;
}

export type GatherRunStartOutcome =
  | { outcome: "started"; run: GatherRunState; queuedRunId: string; position: 0 }
  | { outcome: "queued"; run: GatherRunState; queuedRunId: string; position: number }
  | { outcome: "unsupported-source" }
  | { outcome: "target-unavailable" }
  | { outcome: "failed"; message: string };

export type TerminalGatherRunPhase = "complete" | "failed" | "cancelled" | "interrupted";

export function isTerminalGatherRunPhase(
  phase: GatherRunPhase
): phase is TerminalGatherRunPhase {
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
    error: null,
    queuedCount: 0
  };
}

/**
 * Phases a run may carry when it is read back from storage. `cancelling` is absent, so a run
 * persisted mid-cancel is dropped on load rather than recovered.
 */
const StoredGatherRunPhaseSchema = z.enum([
  "preparing",
  "permission-required",
  "collecting",
  "queued",
  "writing",
  "complete",
  "failed",
  "cancelled",
  "interrupted"
]);

/** Counters written by an older build may be missing or non-numeric; each falls back to zero. */
const StoredGatherRunProgressSchema = z.catch(
  z.object({
    completed: z.catch(z.coerce.number(), 0),
    total: z.catch(z.coerce.number(), 0),
    saved: z.catch(z.coerce.number(), 0),
    skipped: z.catch(z.coerce.number(), 0),
    failed: z.catch(z.coerce.number(), 0),
    message: z.catch(z.string(), "")
  }),
  { completed: 0, total: 0, saved: 0, skipped: 0, failed: 0, message: "" }
);

/**
 * A Gather Run as chrome.storage holds it. The identity fields are required — a record missing
 * any of them is not a run this build can resume — while the accumulated state degrades to empty.
 */
export const GatherRunStateSchema = z.object({
  schemaVersion: z.literal(GATHER_RUN_SCHEMA_VERSION),
  id: z.string(),
  tabId: z.number(),
  windowId: z.number(),
  tabUrl: z.string(),
  siteKey: SiteKeySchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  phase: StoredGatherRunPhaseSchema,
  progress: StoredGatherRunProgressSchema,
  log: lenientArrayOf(LastRunLogEntrySchema),
  destinationPreview: z.catch(z.nullable(z.string()), null),
  folderSegments: lenientArrayOf(z.string()),
  failedItems: lenientArrayOf(DownloadFailureSchema),
  retryImages: lenientArrayOf(DownloadableFileSchema),
  error: z.catch(z.nullable(z.string()), null),
  queuedCount: z.pipe(
    z.catch(z.coerce.number(), 0),
    z.transform((count) => Math.max(0, Math.round(count)))
  )
});
