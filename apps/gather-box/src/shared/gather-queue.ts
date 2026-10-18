import * as z from "zod/mini";
import type { GatherRunState } from "./gather-run";
import { GatherRunStateSchema, isTerminalGatherRunPhase } from "./gather-run";
import { applyGatherRunEvent } from "./gather-run-reducer";
import { DEFAULT_PROFILE_ID } from "./profiles";
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

/** Finished runs kept in full. The batch tally counts every run, however many fall off. */
export const MAX_GATHER_QUEUE_RESULTS = 10;

/** Finished runs listed under the batch summary. */
export const RECENT_BATCH_RUNS = 5;

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
  /**
   * The remembered folder this output was gathered for. Null when none was remembered then, or
   * for jobs queued by an older build; either way the executor writes to the current folder.
   */
  destinationId: string | null;
  /** The profile whose folders this output writes to, fixed when the page was gathered. */
  profileId: string;
}

export type GatherQueueJob = CollectingGatherQueueJob | OutputGatherQueueJob;

/** Running counts for the runs that went through the queue together. */
export interface GatherQueueTally {
  /** When the batch's first run finished; results finished since then belong to the batch. */
  startedAt: number;
  /** When the batch's latest run finished. */
  endedAt: number;
  /** Set once the queue empties, so a page gathered after that starts a new batch. */
  closed: boolean;
  pages: number;
  saved: number;
  skipped: number;
  failed: number;
}

export interface GatherQueueState {
  schemaVersion: typeof GATHER_QUEUE_SCHEMA_VERSION;
  jobs: GatherQueueJob[];
  results: GatherRunState[];
  batch: GatherQueueTally | null;
}

export const EMPTY_GATHER_QUEUE: GatherQueueState = {
  schemaVersion: GATHER_QUEUE_SCHEMA_VERSION,
  jobs: [],
  results: [],
  batch: null
};

const GatherQueueTallySchema = z.object({
  startedAt: z.number(),
  endedAt: z.number(),
  closed: z.boolean(),
  pages: z.number(),
  saved: z.number(),
  skipped: z.number(),
  failed: z.number()
});

const CollectingGatherQueueJobSchema = z.pipe(
  z.object({ run: z.extend(GatherRunStateSchema, { phase: z.literal("collecting") }) }),
  z.transform((job): CollectingGatherQueueJob => ({ kind: "collecting", run: job.run }))
);

/**
 * A job stays `cancelling` until the executor acknowledges the abort, so that phase must survive
 * every load: dropping it would lose the job the cancellation report is addressed to.
 */
const OutputGatherQueueJobSchema = z.pipe(
  z.object({
    run: z.extend(GatherRunStateSchema, {
      phase: z.enum(["preparing", "permission-required", "queued", "writing", "cancelling"])
    }),
    payload: z.union([DownloadablePayloadSchema, GeneratedStoryPayloadSchema]),
    settings: GatherBoxSettingsSchema,
    destinationId: z.catch(z.nullable(z.string()), null),
    profileId: z.catch(z.string(), DEFAULT_PROFILE_ID)
  }),
  z.transform(
    (job): OutputGatherQueueJob => ({
      kind: "output",
      run: job.run,
      payload: job.payload,
      settings: job.settings,
      destinationId: job.destinationId,
      profileId: job.profileId
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
      results: lenientArrayOf(GatherRunStateSchema),
      batch: z.catch(z.nullable(GatherQueueTallySchema), null)
    }),
    z.transform(
      (queue): GatherQueueState => ({
        schemaVersion: queue.schemaVersion,
        jobs: queue.jobs.filter((job) => job !== null).slice(0, MAX_GATHER_QUEUE_LENGTH),
        results: queue.results
          .filter((run) => isTerminalGatherRunPhase(run.phase))
          .slice(-MAX_GATHER_QUEUE_RESULTS),
        batch: queue.batch
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

  const previous = queue.results.find((result) => result.id === run.id);
  const current = queue.batch;
  // Runs ended together are recorded one by one, so a closed batch still takes a run that was
  // waiting in the queue when the batch's latest run finished.
  const open = current && (!current.closed || run.createdAt <= current.endedAt) ? current : null;

  let batch: GatherQueueTally = {
    startedAt: open?.startedAt ?? run.updatedAt,
    endedAt: run.updatedAt,
    closed: queue.jobs.length === 0,
    pages: open?.pages ?? 0,
    saved: open?.saved ?? 0,
    skipped: open?.skipped ?? 0,
    failed: open?.failed ?? 0
  };

  // A run recorded again replaces its earlier result, so it is only counted once.
  if (open && previous && previous.updatedAt >= open.startedAt) {
    batch = tallyRun(batch, previous, -1);
  }

  return {
    ...queue,
    results: [...queue.results.filter((result) => result.id !== run.id), run].slice(
      -MAX_GATHER_QUEUE_RESULTS
    ),
    batch: tallyRun(batch, run, 1)
  };
}

/**
 * Drops a result whose failed items are being retried. Its saved and skipped items stay counted,
 * while its failures and its page now belong to the retry run.
 */
export function withdrawGatherQueueResult(
  queue: GatherQueueState,
  run: GatherRunState
): GatherQueueState {
  const batch = queue.batch;
  const counted = batch !== null && !batch.closed && run.updatedAt >= batch.startedAt;

  return {
    ...queue,
    results: queue.results.filter((result) => result.id !== run.id),
    batch: counted
      ? { ...batch, pages: batch.pages - 1, failed: batch.failed - run.progress.failed }
      : batch
  };
}

function tallyRun(batch: GatherQueueTally, run: GatherRunState, sign: 1 | -1): GatherQueueTally {
  return {
    ...batch,
    pages: batch.pages + sign,
    saved: batch.saved + sign * run.progress.saved,
    skipped: batch.skipped + sign * run.progress.skipped,
    failed: batch.failed + sign * run.progress.failed
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

/**
 * The paused job a gather from this site under this profile confirms folder access for: only that
 * combination prompts for the same folder handle the job is waiting on.
 */
export function getPermissionRequiredGatherJob(
  queue: GatherQueueState,
  siteKey: SiteKey,
  profileId: string
): OutputGatherQueueJob | null {
  return (
    queue.jobs.find(
      (job): job is OutputGatherQueueJob =>
        job.kind === "output" &&
        job.run.phase === "permission-required" &&
        job.profileId === profileId &&
        (job.settings.useGlobalFolder || job.run.siteKey === siteKey)
    ) ?? null
  );
}

/**
 * Runs that leave the queue without finishing — after a browser restart, interrupted page
 * captures and cancellations the executor never acknowledged — are reported alongside the new
 * queue so they can be recorded as results.
 */
export interface GatherQueueRecovery {
  queue: GatherQueueState;
  ended: GatherRunState[];
}

export function recoverStoppedGatherQueue(
  queue: GatherQueueState,
  now = Date.now()
): GatherQueueRecovery {
  const jobs: GatherQueueJob[] = [];
  const ended: GatherRunState[] = [];

  for (const job of queue.jobs) {
    if (job.kind === "collecting") {
      ended.push({
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

    // The person already asked to stop this output, so a restart finishes the cancellation
    // rather than replaying it.
    if (job.run.phase === "cancelling") {
      ended.push(
        applyGatherRunEvent(job.run, { kind: "cancelled", message: "Gather Run cancelled." }, now)
      );
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

  return { queue: { ...queue, jobs }, ended };
}

export const PROFILE_DELETED_MESSAGE =
  "The profile this page was gathered under was deleted, so it has no folder to save to.";

/**
 * Outputs still waiting on a deleted profile can never be written: nothing can confirm a folder
 * the profile no longer remembers, and a paused one would hold up the whole queue. They end here
 * instead. Outputs already writing keep the folder they opened and finish.
 */
export function endDeletedProfileJobs(
  queue: GatherQueueState,
  profileIds: ReadonlySet<string>,
  now = Date.now()
): GatherQueueRecovery {
  const jobs: GatherQueueJob[] = [];
  const ended: GatherRunState[] = [];

  for (const job of queue.jobs) {
    if (
      job.kind === "output" &&
      (job.run.phase === "queued" || job.run.phase === "permission-required") &&
      !profileIds.has(job.profileId)
    ) {
      ended.push(
        applyGatherRunEvent(job.run, { kind: "failed", message: PROFILE_DELETED_MESSAGE }, now)
      );
      continue;
    }

    jobs.push(job);
  }

  return { queue: { ...queue, jobs }, ended };
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

  return { ...displayed.run, queuedCount };
}

export interface GatherQueueBatch {
  /** The batch's most recent finished runs, newest first. */
  recent: GatherRunState[];
  pages: number;
  saved: number;
  skipped: number;
  failed: number;
}

/**
 * The runs that went through the queue together with the newest one. Runs queued while others
 * were working stay together; once the queue empties, the next page gathered starts afresh.
 */
export function getGatherQueueBatch(queue: GatherQueueState): GatherQueueBatch {
  const tally = queue.batch;

  if (!tally || (tally.closed && queue.jobs.length > 0)) {
    return { recent: [], pages: 0, saved: 0, skipped: 0, failed: 0 };
  }

  const recent = queue.results
    .filter((result) => result.updatedAt >= tally.startedAt)
    .slice(-RECENT_BATCH_RUNS)
    .reverse();

  return {
    recent,
    pages: tally.pages,
    saved: tally.saved,
    skipped: tally.skipped,
    failed: tally.failed
  };
}
