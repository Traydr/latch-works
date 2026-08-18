import * as z from "zod/mini";
import type { GatherRunState } from "./gather-run";
import { GatherRunStateSchema, isTerminalGatherRunPhase } from "./gather-run";
import { GatherBoxSettingsSchema, type GatherBoxSettings } from "./settings";
import { lenientArrayOf } from "./lenient-array";
import {
  DownloadablePayloadSchema,
  GeneratedStoryPayloadSchema,
  type DownloadablePayload,
  type GeneratedStoryPayload
} from "./types";
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

const CollectingGatherQueueJobSchema = z.pipe(
  z.object({ run: z.extend(GatherRunStateSchema, { phase: z.literal("collecting") }) }),
  z.transform((job): CollectingGatherQueueJob => ({ kind: "collecting", run: job.run }))
);

/**
 * `GatherRunStateSchema` never yields `cancelling`, so a job stored mid-cancel does not survive
 * a reload; the phases below are the ones a queued output job can actually be read back with.
 */
const OutputGatherQueueJobSchema = z.pipe(
  z.object({
    run: z.extend(GatherRunStateSchema, {
      phase: z.enum(["preparing", "permission-required", "queued", "writing"])
    }),
    payload: z.union([DownloadablePayloadSchema, GeneratedStoryPayloadSchema]),
    settings: GatherBoxSettingsSchema
  }),
  z.transform(
    (job): OutputGatherQueueJob => ({
      kind: "output",
      run: job.run,
      payload: job.payload,
      settings: job.settings
    })
  )
);

/** A job's kind is re-derived from the run phase, so a stored `kind` field is ignored. */
const GatherQueueJobSchema = z.union([
  CollectingGatherQueueJobSchema,
  OutputGatherQueueJobSchema
]);

export const GatherQueueStateSchema = z.catch(
  z.pipe(
    z.object({
      schemaVersion: z.literal(GATHER_QUEUE_SCHEMA_VERSION),
      jobs: z.array(z.catch(z.nullable(GatherQueueJobSchema), null)),
      results: lenientArrayOf(GatherRunStateSchema)
    }),
    z.transform(
      (queue): GatherQueueState => ({
        schemaVersion: queue.schemaVersion,
        jobs: queue.jobs.filter((job) => job !== null).slice(0, MAX_GATHER_QUEUE_LENGTH),
        results: queue.results
          .filter((run) => isTerminalGatherRunPhase(run.phase))
          .slice(-MAX_GATHER_QUEUE_RESULTS)
      })
    )
  ),
  () => ({ ...EMPTY_GATHER_QUEUE, jobs: [], results: [] })
);

export async function loadGatherQueue(): Promise<GatherQueueState> {
  const stored = await chrome.storage.local.get(GATHER_QUEUE_STATE_KEY);
  return GatherQueueStateSchema.parse(stored[GATHER_QUEUE_STATE_KEY]);
}

export async function saveGatherQueue(queue: GatherQueueState): Promise<void> {
  await chrome.storage.local.set({ [GATHER_QUEUE_STATE_KEY]: queue });
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

/** Runs that could not be resumed after a browser restart are reported alongside the new queue. */
export interface GatherQueueRecovery {
  queue: GatherQueueState;
  interrupted: GatherRunState[];
}

export function recoverStoppedGatherQueue(
  queue: GatherQueueState,
  now = Date.now()
): GatherQueueRecovery {
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

