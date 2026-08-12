import type { GatherRunState } from "./gather-run";
import { normalizeGatherRunState } from "./gather-run";
import { normalizeSettings, type GatherBoxSettings } from "./settings";
import type { DownloadablePayload, GeneratedStoryPayload } from "./types";

export const GATHER_QUEUE_STATE_KEY = "gather-box-run-queue";
export const GATHER_QUEUE_SCHEMA_VERSION = 1;
export const MAX_GATHER_QUEUE_LENGTH = 100;

export type GatherOutput = DownloadablePayload | GeneratedStoryPayload;

export interface GatherQueueJob {
  run: GatherRunState;
  payload: GatherOutput | null;
  settings: GatherBoxSettings | null;
}

export interface GatherQueueState {
  schemaVersion: typeof GATHER_QUEUE_SCHEMA_VERSION;
  jobs: GatherQueueJob[];
}

export const EMPTY_GATHER_QUEUE: GatherQueueState = {
  schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
  jobs: []
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
      .slice(0, MAX_GATHER_QUEUE_LENGTH)
  };
}

export function getExecutingGatherJob(queue: GatherQueueState): GatherQueueJob | null {
  return (
    queue.jobs.find(
      (job) =>
        job.run.phase === "preparing" ||
        job.run.phase === "writing" ||
        job.run.phase === "permission-required"
    ) ?? null
  );
}

export function getNextQueuedGatherJob(queue: GatherQueueState): GatherQueueJob | null {
  if (getExecutingGatherJob(queue)) {
    return null;
  }

  return (
    queue.jobs.find(
      (job) => job.run.phase === "queued" && Boolean(job.payload) && Boolean(job.settings)
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
    if (job.run.phase === "collecting" || !job.payload || !job.settings) {
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
        job.run.phase === "preparing" || job.run.phase === "writing"
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
    queue.jobs.find((job) => job.run.phase === "collecting") ??
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

  const candidate = value as Partial<GatherQueueJob>;
  const run = normalizeGatherRunState(candidate.run);
  if (!run || !isGatherOutput(candidate.payload)) {
    if (run?.phase === "collecting" && candidate.payload == null) {
      return { run, payload: null, settings: null };
    }
    return null;
  }

  return {
    run,
    payload: candidate.payload,
    settings:
      candidate.settings && typeof candidate.settings === "object"
        ? normalizeSettings(candidate.settings)
        : null
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
