import type { GatherRunState } from "./gather-run";
import { isTerminalGatherRunPhase, normalizeGatherRunState } from "./gather-run";
import { normalizeSettings, type GatherBoxSettings } from "./settings";
import type { DownloadablePayload, GeneratedStoryPayload } from "./types";
import type { SiteKey } from "./sites";

export const GATHER_QUEUE_STATE_KEY = "gather-box-run-queue";
export const GATHER_QUEUE_SCHEMA_VERSION = 1;
export const MAX_GATHER_QUEUE_LENGTH = 100;
export const MAX_GATHER_QUEUE_RESULTS = 100;

export type GatherOutput = DownloadablePayload | GeneratedStoryPayload;

export interface CollectingGatherQueueJob {
  kind: "collecting";
  run: GatherRunState & { phase: "collecting" };
}

export interface OutputGatherQueueJob {
  kind: "output";
  run: GatherRunState & {
    phase: "queued" | "preparing" | "permission-required" | "writing" | "cancelling";
  };
  payload: GatherOutput;
  settings: GatherBoxSettings;
}

export type GatherQueueJob = CollectingGatherQueueJob | OutputGatherQueueJob;

export interface GatherQueueState {
  schemaVersion: typeof GATHER_QUEUE_SCHEMA_VERSION;
  jobs: GatherQueueJob[];
  results: GatherRunState[];
}

export const EMPTY_GATHER_QUEUE: GatherQueueState = {
  schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
  jobs: [],
  results: []
};

export async function loadGatherQueue(): Promise<GatherQueueState> {
  const stored = await chrome.storage.local.get(GATHER_QUEUE_STATE_KEY);
  return normalizeGatherQueueState(stored[GATHER_QUEUE_STATE_KEY]);
}

export async function saveGatherQueue(queue: GatherQueueState): Promise<void> {
  await chrome.storage.local.set({ [GATHER_QUEUE_STATE_KEY]: queue });
}

export function normalizeGatherQueueState(value: unknown): GatherQueueState {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_GATHER_QUEUE };
  }

  const candidate = value as Partial<GatherQueueState>;
  if (
    candidate.schemaVersion !== GATHER_QUEUE_SCHEMA_VERSION ||
    !Array.isArray(candidate.jobs)
  ) {
    return { ...EMPTY_GATHER_QUEUE };
  }

  return {
    schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
    jobs: candidate.jobs
      .map(normalizeGatherQueueJob)
      .filter((job): job is GatherQueueJob => Boolean(job))
      .slice(0, MAX_GATHER_QUEUE_LENGTH),
    results: Array.isArray(candidate.results)
      ? candidate.results
          .map(normalizeGatherRunState)
          .filter((run): run is GatherRunState => run !== null)
          .filter((run) => isTerminalGatherRunPhase(run.phase))
          .slice(-MAX_GATHER_QUEUE_RESULTS)
      : []
  };
}

export function getLatestGatherQueueResult(queue: GatherQueueState): GatherRunState | null {
  return queue.results.at(-1) ?? null;
}

export function getRetryableGatherQueueResult(queue: GatherQueueState): GatherRunState | null {
  for (let index = queue.results.length - 1; index >= 0; index -= 1) {
    if (queue.results[index].retryImages.length > 0) {
      return queue.results[index];
    }
  }
  return null;
}

export function recordGatherQueueResult(
  queue: GatherQueueState,
  run: GatherRunState
): GatherQueueState {
  if (!isTerminalGatherRunPhase(run.phase)) {
    throw new Error(`Cannot record non-terminal Gather Run ${run.id}.`);
  }
  return {
    ...queue,
    results: [...queue.results.filter((result) => result.id !== run.id), run].slice(
      -MAX_GATHER_QUEUE_RESULTS
    )
  };
}

export function getExecutingGatherJob(queue: GatherQueueState): OutputGatherQueueJob | null {
  return (
    queue.jobs.find(
      (job): job is OutputGatherQueueJob =>
        job.kind === "output" &&
        (job.run.phase === "preparing" ||
          job.run.phase === "writing" ||
          job.run.phase === "cancelling" ||
          job.run.phase === "permission-required")
    ) ?? null
  );
}

export function getNextQueuedGatherJob(queue: GatherQueueState): OutputGatherQueueJob | null {
  if (getExecutingGatherJob(queue)) {
    return null;
  }

  const first = queue.jobs[0];
  return first?.kind === "output" && first.run.phase === "queued" ? first : null;
}

export function getPermissionRequiredGatherJob(
  queue: GatherQueueState,
  siteKey: SiteKey
): OutputGatherQueueJob | null {
  return (
    queue.jobs.find(
      (job): job is OutputGatherQueueJob =>
        job.kind === "output" &&
        job.run.phase === "permission-required" &&
        (job.settings.useGlobalFolder || job.run.siteKey === siteKey)
    ) ?? null
  );
}

export function recoverStoppedGatherQueue(
  queue: GatherQueueState,
  now = Date.now()
): { queue: GatherQueueState; interrupted: GatherRunState[] } {
  const jobs: GatherQueueJob[] = [];
  const interrupted: GatherRunState[] = [];

  for (const job of queue.jobs) {
    if (job.kind === "collecting") {
      interrupted.push({
        ...job.run,
        phase: "interrupted",
        updatedAt: now,
        error: "The browser stopped collection before the page metadata was captured.",
        progress: {
          ...job.run.progress,
          message: "Collection was interrupted. Queue this page again."
        }
      });
      continue;
    }

    jobs.push({
      ...job,
      run:
        job.run.phase === "preparing" ||
        job.run.phase === "writing" ||
        job.run.phase === "cancelling"
          ? {
              ...job.run,
              phase: "queued",
              updatedAt: now,
              progress: {
                ...job.run.progress,
                completed: 0,
                message: "Recovered and queued after browser restart."
              }
            }
          : job.run
    });
  }

  return { queue: { ...queue, jobs }, interrupted };
}

export function getGatherQueueDisplayRun(queue: GatherQueueState): GatherRunState | null {
  const displayed =
    getExecutingGatherJob(queue) ??
    queue.jobs.find((job) => job.kind === "collecting") ??
    queue.jobs.find((job) => job.run.phase === "queued") ??
    null;
  if (!displayed) {
    return null;
  }

  const queuedCount = queue.jobs.filter(
    (job) =>
      job.run.id !== displayed.run.id &&
      (job.run.phase === "collecting" || job.run.phase === "queued")
  ).length;
  const queueSuffix = queuedCount === 1 ? " · 1 queued" : ` · ${queuedCount} queued`;

  return {
    ...displayed.run,
    queuedCount,
    progress: {
      ...displayed.run.progress,
      message:
        queuedCount > 0
          ? `${displayed.run.progress.message}${queueSuffix}`
          : displayed.run.progress.message
    }
  };
}

function normalizeGatherQueueJob(value: unknown): GatherQueueJob | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    run?: unknown;
    payload?: unknown;
    settings?: unknown;
  };
  const run = normalizeGatherRunState(candidate.run);
  if (!run) {
    return null;
  }

  if (run.phase === "collecting") {
    return { kind: "collecting", run: run as CollectingGatherQueueJob["run"] };
  }

  if (
    isTerminalGatherRunPhase(run.phase) ||
    !isGatherOutput(candidate.payload) ||
    !candidate.settings ||
    typeof candidate.settings !== "object"
  ) {
    return null;
  }

  return {
    kind: "output",
    run: run as OutputGatherQueueJob["run"],
    payload: candidate.payload,
    settings: normalizeSettings(candidate.settings)
  };
}

function isGatherOutput(value: unknown): value is GatherOutput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const output = value as Partial<GatherOutput>;
  return (
    output.ok === true &&
    typeof output.site === "string" &&
    typeof output.title === "string" &&
    typeof output.pageUrl === "string" &&
    Array.isArray(output.folderSegments) &&
    ((output.outputKind === "downloadable-files" && Array.isArray(output.images)) ||
      (output.outputKind === "generated-story-pdf" && Array.isArray(output.chapters)))
  );
}
