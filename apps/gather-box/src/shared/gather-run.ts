import * as z from "zod/mini";
import { lenientArrayOf } from "./lenient-array";
import type { SiteKey } from "./source-catalog";
import {
  type DownloadableFile,
  DownloadableFileSchema,
  type GatherOutput,
  SiteKeySchema,
} from "./types";

const GATHER_RUN_SCHEMA_VERSION = 1;

/** The page is still being read by its collector; nothing is queued yet. */
const COLLECTING_PHASES = ["collecting"] as const;

/** A collected output in the queue, from waiting its turn until it leaves the executor. */
export const OUTPUT_PHASES = [
  "queued",
  "preparing",
  "permission-required",
  "writing",
  "cancelling",
] as const;

/** The output holding the executor's turn: every other output waits behind it. */
const EXECUTING_PHASES = ["preparing", "permission-required", "writing", "cancelling"] as const;

/** The executor is working on the output, so cancelling it means asking the executor to stop. */
const ABORTABLE_PHASES = ["preparing", "writing", "cancelling"] as const;

/** Outputs that have not opened their folder yet. */
const WAITING_PHASES = ["queued", "permission-required"] as const;

/** Outputs whose progress counts files written. */
const WRITING_PHASES = ["writing", "cancelling"] as const;

const TERMINAL_PHASES = ["complete", "failed", "cancelled", "interrupted"] as const;

const GatherRunPhaseSchema = z.enum([...COLLECTING_PHASES, ...OUTPUT_PHASES, ...TERMINAL_PHASES]);

export type GatherRunPhase = z.infer<typeof GatherRunPhaseSchema>;

export type OutputGatherRunPhase = (typeof OUTPUT_PHASES)[number];

function phaseGroup<Phase extends GatherRunPhase>(phases: readonly Phase[]) {
  const members: ReadonlySet<GatherRunPhase> = new Set(phases);

  return (phase: GatherRunPhase): phase is Phase => members.has(phase);
}

export const isOutputPhase = phaseGroup(OUTPUT_PHASES);

export const isExecutingPhase = phaseGroup(EXECUTING_PHASES);

export const isAbortablePhase = phaseGroup(ABORTABLE_PHASES);

export const isWaitingPhase = phaseGroup(WAITING_PHASES);

export const isWritingPhase = phaseGroup(WRITING_PHASES);

export const isTerminalGatherRunPhase = phaseGroup(TERMINAL_PHASES);

export const RUN_CANCELLED_MESSAGE = "Gather Run cancelled.";

export function queueFullMessage(limit: number): string {
  return `The Gather queue is full (${limit} items).`;
}

/**
 * Why an item failed. A site check is a bot challenge in front of the file: the browser can still
 * download it when you open the link yourself, and you then hand the file back to be saved.
 */
const DownloadFailureKindSchema = z.enum(["error", "site-check"]);

export const DownloadFailureSchema = z.object({
  fileName: z.string(),
  reason: z.string(),
  originalUrl: z.optional(z.string()),
  // Failures recorded by older builds carry no kind and were ordinary errors.
  kind: z.catch(DownloadFailureKindSchema, "error"),
});

export type DownloadFailure = z.infer<typeof DownloadFailureSchema>;

export const RunLogEntrySchema = z.object({
  message: z.string(),
  tone: z.optional(z.enum(["error", "success"])),
});

export type RunLogEntry = z.infer<typeof RunLogEntrySchema>;

const GatherRunProgressSchema = z.object({
  completed: z.number(),
  total: z.number(),
  saved: z.number(),
  skipped: z.number(),
  failed: z.number(),
  message: z.string(),
});

type GatherRunProgress = z.infer<typeof GatherRunProgressSchema>;

function emptyProgress(message: string): GatherRunProgress {
  return { completed: 0, total: 0, saved: 0, skipped: 0, failed: 0, message };
}

/** The items an output's progress counts: chapters for a story, files otherwise. */
export function outputTotal(output: GatherOutput): number {
  return output.outputKind === "generated-story-pdf"
    ? output.chapters.length
    : output.images.length;
}

/** Which folder handle a paused job is waiting on, so the panel can say where to confirm it. */
export const GatherFolderScopeSchema = z.enum(["global", "site"]);

/** The remembered folder an output writes to: one for every site, or one for its own site. */
export type FolderScope = { kind: "global" } | { kind: "site"; siteKey: SiteKey };

/** Null when folders are remembered per site and there is no site to remember one for. */
export function folderScope(siteKey: SiteKey, useGlobalFolder: boolean): FolderScope;

export function folderScope(siteKey: SiteKey | null, useGlobalFolder: boolean): FolderScope | null;

export function folderScope(siteKey: SiteKey | null, useGlobalFolder: boolean): FolderScope | null {
  if (useGlobalFolder) {
    return { kind: "global" };
  }

  return siteKey ? { kind: "site", siteKey } : null;
}

/** Whether a gather from this site prompts for the folder handle of this scope. */
export function folderScopeCovers(scope: FolderScope, siteKey: SiteKey): boolean {
  return scope.kind === "global" || scope.siteKey === siteKey;
}

export interface GatherRunState {
  schemaVersion: typeof GATHER_RUN_SCHEMA_VERSION;
  id: string;
  tabId: number;
  windowId: number;
  tabUrl: string;
  siteKey: SiteKey;
  /** The gathered page's title, known once collection captures it. */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  phase: GatherRunPhase;
  progress: GatherRunProgress;
  log: RunLogEntry[];
  destinationPreview: string | null;
  folderSegments: string[];
  failedItems: DownloadFailure[];
  retryImages: DownloadableFile[];
  error: string | null;
  queuedCount: number;
}

export type GatherRunStartOutcome =
  | { outcome: "started"; run: GatherRunState; queuedRunId: string; position: 0 }
  | { outcome: "queued"; run: GatherRunState; queuedRunId: string; position: number }
  | { outcome: "unsupported-source" }
  | { outcome: "target-unavailable" }
  | { outcome: "failed"; message: string };

export type GatherRunCancelOutcome =
  | { outcome: "cancelled"; run: GatherRunState }
  | { outcome: "idle" }
  | { outcome: "failed"; message: string };

/** A new run in its first phase, its progress showing `message` and its log `log`. */
export function createGatherRunState<Phase extends GatherRunPhase>(input: {
  id: string;
  tabId: number;
  windowId: number;
  tabUrl: string;
  siteKey: SiteKey;
  phase: Phase;
  message: string;
  log?: RunLogEntry[];
  now?: number;
}): GatherRunState & { phase: Phase } {
  const now = input.now ?? Date.now();

  return {
    schemaVersion: GATHER_RUN_SCHEMA_VERSION,
    id: input.id,
    tabId: input.tabId,
    windowId: input.windowId,
    tabUrl: input.tabUrl,
    siteKey: input.siteKey,
    title: null,
    createdAt: now,
    updatedAt: now,
    phase: input.phase,
    progress: emptyProgress(input.message),
    log: input.log ?? [],
    destinationPreview: null,
    folderSegments: [],
    failedItems: [],
    retryImages: [],
    error: null,
    queuedCount: 0,
  };
}

/** Counters written by an older build may be missing or non-numeric; each falls back to zero. */
const StoredGatherRunProgressSchema = z.catch(
  z.object({
    completed: z.catch(z.coerce.number(), 0),
    total: z.catch(z.coerce.number(), 0),
    saved: z.catch(z.coerce.number(), 0),
    skipped: z.catch(z.coerce.number(), 0),
    failed: z.catch(z.coerce.number(), 0),
    message: z.catch(z.string(), ""),
  }),
  () => emptyProgress(""),
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
  title: z.catch(z.nullable(z.string()), null),
  createdAt: z.number(),
  updatedAt: z.number(),
  phase: GatherRunPhaseSchema,
  progress: StoredGatherRunProgressSchema,
  log: lenientArrayOf(RunLogEntrySchema),
  destinationPreview: z.catch(z.nullable(z.string()), null),
  folderSegments: lenientArrayOf(z.string()),
  failedItems: lenientArrayOf(DownloadFailureSchema),
  retryImages: lenientArrayOf(DownloadableFileSchema),
  error: z.catch(z.nullable(z.string()), null),
  queuedCount: z.pipe(
    z.catch(z.coerce.number(), 0),
    z.transform((count) => Math.max(0, Math.round(count))),
  ),
});
