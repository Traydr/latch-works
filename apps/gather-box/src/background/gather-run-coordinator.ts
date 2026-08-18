import { formatError, toError } from "../gather/errors";
import {
  getGatherQueueDisplayRun,
  getNextQueuedGatherJob,
  getPermissionRequiredGatherJob,
  getRetryableGatherQueueResult,
  loadGatherQueue,
  MAX_GATHER_QUEUE_LENGTH,
  recordGatherQueueResult,
  recoverStoppedGatherQueue,
  type CollectingGatherQueueJob,
  type GatherQueueState,
  type OutputGatherQueueJob
} from "../shared/gather-queue";
import type {
  GatherRunCancelOutcome,
  GatherRunEventMessage
} from "../shared/gather-run-messages";
import {
  createGatherRunState,
  isTerminalGatherRunPhase,
  type GatherRunStartOutcome,
  type GatherRunState
} from "../shared/gather-run";
import { getSiteKeyFromUrl, isSupportedUrl, type SiteKey } from "../shared/sites";
import type { DownloadablePayload } from "../shared/types";
import { applyGatherRunEvent } from "../shared/gather-run-reducer";
import {
  createChromeCoordinatorDependencies,
  type GatherRunCoordinatorDependencies
} from "./gather-run-coordinator-dependencies";

export { applyGatherRunEvent } from "../shared/gather-run-reducer";
export type { GatherRunCoordinatorDependencies } from "./gather-run-coordinator-dependencies";

type Reservation =
  | { kind: "collect"; run: CollectingGatherQueueJob["run"]; position: number }
  | { kind: "existing"; runId: string; position: number }
  | { kind: "outcome"; outcome: GatherRunStartOutcome };

interface ReservationResult {
  reservation: Reservation;
  /** A paused job was unblocked by this intent and needs dispatching before the new page. */
  resumed: boolean;
}

export class GatherRunCoordinator {
  private operationQueue = Promise.resolve();

  constructor(
    private readonly dependencies: GatherRunCoordinatorDependencies =
      createChromeCoordinatorDependencies()
  ) {}

  async startForTab(tab: chrome.tabs.Tab): Promise<GatherRunStartOutcome> {
    if (typeof tab.id !== "number" || tab.windowId === undefined || !tab.url) {
      return { outcome: "target-unavailable" };
    }
    if (!isSupportedUrl(tab.url)) {
      return { outcome: "unsupported-source" };
    }
    const siteKey = getSiteKeyFromUrl(tab.url);
    if (!siteKey) {
      return { outcome: "unsupported-source" };
    }

    const { reservation, resumed } = await this.reserve(tab, siteKey);
    if (resumed || reservation.kind === "existing") {
      await this.dispatchNext();
    }
    if (reservation.kind === "outcome") {
      return reservation.outcome;
    }
    if (reservation.kind === "existing") {
      return this.outcomeForJob(reservation.runId, reservation.position);
    }

    return this.finishCollection(tab, siteKey, reservation);
  }

  async retry(runId: string): Promise<GatherRunStartOutcome> {
    const previous = await this.exclusive(async () => {
      const queue = await this.dependencies.loadQueue();
      const result = getRetryableGatherQueueResult(queue);
      return result?.id === runId ? result : null;
    });
    if (!previous) {
      return { outcome: "failed", message: "No retryable Gather Run was found." };
    }

    const settings = await this.dependencies.loadSettings();
    const payload: DownloadablePayload = {
      ok: true,
      outputKind: "downloadable-files",
      site: previous.siteKey,
      title: "Retry",
      pageUrl: previous.tabUrl,
      galleryId: null,
      folderSegments: previous.folderSegments,
      skippedCount: 0,
      images: previous.retryImages
    };
    const reservation = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        return null;
      }
      const run = asOutputRun({
        ...createGatherRunState({
          id: this.dependencies.randomUUID(),
          tabId: previous.tabId,
          windowId: previous.windowId,
          tabUrl: previous.tabUrl,
          siteKey: previous.siteKey,
          now: this.dependencies.now()
        }),
        phase: "queued",
        folderSegments: payload.folderSegments,
        progress: {
          completed: 0,
          total: payload.images.length,
          saved: 0,
          skipped: 0,
          failed: 0,
          message: `Queued "${payload.title}".`
        },
        log: [{ message: `Queued retry for ${previous.retryImages.length} failed item(s).` }]
      });
      const position = queue.jobs.length;
      queue = {
        ...queue,
        jobs: [...queue.jobs, { kind: "output", run, payload, settings }],
        results: queue.results.filter((result) => result.id !== previous.id)
      };
      await this.dependencies.saveQueue(queue);
      return { runId: run.id, position };
    });
    if (!reservation) {
      return {
        outcome: "failed",
        message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
      };
    }

    await this.dispatchNext();
    return this.outcomeForJob(reservation.runId, reservation.position);
  }

  async cancel(runId: string): Promise<GatherRunCancelOutcome> {
    const decision = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === runId);
      if (!job) {
        return { kind: "idle" } as const;
      }

      if (
        job.kind === "output" &&
        (job.run.phase === "preparing" ||
          job.run.phase === "writing" ||
          job.run.phase === "cancelling")
      ) {
        const run = asOutputRun({
          ...job.run,
          phase: "cancelling",
          updatedAt: this.dependencies.now(),
          progress: { ...job.run.progress, message: "Cancelling Gather Run..." }
        });
        queue = replaceJob(queue, { ...job, run });
        await this.dependencies.saveQueue(queue);
        return { kind: "abort", run } as const;
      }

      const cancelled = applyGatherRunEvent(job.run, {
        kind: "cancelled",
        message: "Gather Run cancelled."
      }, this.dependencies.now());
      queue = recordAndRemove(queue, cancelled);
      await this.dependencies.saveQueue(queue);
      return { kind: "done", run: cancelled } as const;
    });

    if (decision.kind === "idle") {
      return { outcome: "idle" };
    }
    if (decision.kind === "done") {
      await this.dispatchNext();
      return { outcome: "cancelled", run: decision.run };
    }

    const aborted = await this.dependencies.abort(runId).catch(() => false);
    if (!aborted) {
      await this.handleEvent({
        type: "GATHER_BOX_RUN_EVENT",
        target: "background",
        runId,
        event: { kind: "cancelled", message: "Gather Run cancelled." }
      });
    }
    return { outcome: "cancelled", run: decision.run };
  }

  async handleEvent(message: GatherRunEventMessage): Promise<void> {
    const shouldDispatch = await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === message.runId);
      if (!job || job.kind !== "output") {
        return false;
      }
      if (job.run.phase === "cancelling" && message.event.kind !== "cancelled") {
        return false;
      }

      const updated = applyGatherRunEvent(job.run, message.event, this.dependencies.now());
      if (isTerminalGatherRunPhase(updated.phase)) {
        queue = recordAndRemove(queue, updated);
        await this.dependencies.saveQueue(queue);
        return true;
      }

      queue = replaceJob(queue, { ...job, run: asOutputRun(updated) });
      await this.dependencies.saveQueue(queue);
      return false;
    });

    if (shouldDispatch) {
      await this.dispatchNext();
    }
  }

  async recover(): Promise<void> {
    const activeRunId = await this.dependencies.getActiveRunId();
    await this.exclusive(async () => {
      let queue = await this.dependencies.loadQueue();
      if (activeRunId && queue.jobs.some((job) => job.run.id === activeRunId)) {
        return;
      }

      const recovered = recoverStoppedGatherQueue(queue, this.dependencies.now());
      queue = recovered.interrupted.reduce(recordGatherQueueResult, recovered.queue);
      await this.dependencies.saveQueue(queue);
    });
    await this.dispatchNext();
  }

  private async reserve(tab: chrome.tabs.Tab, siteKey: SiteKey): Promise<ReservationResult> {
    return this.exclusive(async () => {
      const loaded = await this.dependencies.loadQueue();
      // Confirming folder access unblocks a paused job, but it is not a request to gather that
      // job's page again. The tab in hand still gets collected on its own.
      const permissionJob = getPermissionRequiredGatherJob(loaded, siteKey);
      let queue = permissionJob
        ? replaceJob(loaded, resumePermissionJob(permissionJob, this.dependencies.now()))
        : loaded;
      const resumed = permissionJob !== null;
      let reservation: Reservation;

      const duplicate = queue.jobs.find((job) => job.run.tabUrl === tab.url);
      if (duplicate) {
        reservation = {
          kind: "existing",
          runId: duplicate.run.id,
          position: queue.jobs.indexOf(duplicate)
        };
      } else if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
        reservation = {
          kind: "outcome",
          outcome: {
            outcome: "failed",
            message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
          }
        };
      } else {
        const run = asCollectingRun({
          ...createGatherRunState({
            id: this.dependencies.randomUUID(),
            tabId: tab.id!,
            windowId: tab.windowId!,
            tabUrl: tab.url!,
            siteKey,
            now: this.dependencies.now()
          }),
          phase: "collecting",
          log: [{ message: "Collecting content metadata..." }],
          progress: {
            completed: 0,
            total: 0,
            saved: 0,
            skipped: 0,
            failed: 0,
            message: "Collecting content metadata..."
          }
        });
        reservation = { kind: "collect", run, position: queue.jobs.length };
        queue = { ...queue, jobs: [...queue.jobs, { kind: "collecting", run }] };
      }

      if (queue !== loaded) {
        await this.dependencies.saveQueue(queue);
      }
      return { reservation, resumed };
    });
  }

  private async finishCollection(
    tab: chrome.tabs.Tab,
    siteKey: SiteKey,
    reservation: Extract<Reservation, { kind: "collect" }>
  ): Promise<GatherRunStartOutcome> {
    try {
      const currentTab = await this.dependencies.getTab(tab.id!);
      if (
        !currentTab.url ||
        currentTab.url !== reservation.run.tabUrl ||
        getSiteKeyFromUrl(currentTab.url) !== siteKey
      ) {
        throw new Error("The source tab navigated before collection started.");
      }
      const [payload, settings] = await Promise.all([
        this.dependencies.collect(currentTab, reservation.run),
        this.dependencies.loadSettings()
      ]);
      const total =
        payload.outputKind === "generated-story-pdf"
          ? payload.chapters.length
          : payload.images.length;
      const completed = await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        const index = queue.jobs.findIndex((job) => job.run.id === reservation.run.id);
        if (index < 0 || queue.jobs[index].kind !== "collecting") {
          return false;
        }
        const run = asOutputRun({
          ...reservation.run,
          phase: "queued",
          updatedAt: this.dependencies.now(),
          folderSegments: payload.folderSegments,
          progress: { ...reservation.run.progress, total, message: `Queued "${payload.title}".` },
          log: [
            ...reservation.run.log,
            { message: `Queued ${total} item(s) from "${payload.title}".`, tone: "success" }
          ]
        });
        const jobs = [...queue.jobs];
        jobs[index] = { kind: "output", run, payload, settings };
        queue = { ...queue, jobs };
        await this.dependencies.saveQueue(queue);
        return true;
      });
      if (!completed) {
        return { outcome: "failed", message: "The queued Gather Run was cancelled." };
      }

      await this.dispatchNext();
      return this.outcomeForJob(reservation.run.id, reservation.position);
    } catch (error) {
      const failed = applyGatherRunEvent(
        reservation.run,
        { kind: "failed", message: formatError(toError(error)) },
        this.dependencies.now()
      );
      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        if (!queue.jobs.some((job) => job.run.id === reservation.run.id)) {
          return;
        }
        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
      await this.dispatchNext();
      return { outcome: "failed", message: failed.error ?? "Gather Run failed." };
    }
  }

  private async dispatchNext(): Promise<void> {
    while (true) {
      const job = await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        const next = getNextQueuedGatherJob(queue);
        if (!next) {
          return null;
        }
        const run = asOutputRun({
          ...next.run,
          phase: "preparing",
          updatedAt: this.dependencies.now(),
          progress: {
            ...next.run.progress,
            completed: 0,
            message: "Starting queued Gather Output..."
          }
        });
        const claimed = { ...next, run };
        queue = replaceJob(queue, claimed);
        await this.dependencies.saveQueue(queue);
        return claimed;
      });
      if (!job) {
        return;
      }

      const accepted = await this.dependencies.execute(job).catch(() => false);
      if (accepted) {
        return;
      }

      const failed = applyGatherRunEvent(
        job.run,
        { kind: "failed", message: "The Gather executor did not accept the queued output." },
        this.dependencies.now()
      );
      await this.exclusive(async () => {
        let queue = await this.dependencies.loadQueue();
        if (!queue.jobs.some((candidate) => candidate.run.id === job.run.id)) {
          return;
        }
        queue = recordAndRemove(queue, failed);
        await this.dependencies.saveQueue(queue);
      });
    }
  }

  private async outcomeForJob(
    runId: string,
    requestedPosition: number
  ): Promise<GatherRunStartOutcome> {
    const queue = await this.exclusive(() => this.dependencies.loadQueue());
    const job = queue.jobs.find((candidate) => candidate.run.id === runId);
    const completed = queue.results.find((result) => result.id === runId);
    if (!job && !completed) {
      return { outcome: "failed", message: "The queued Gather Run could not be restored." };
    }
    const run = getGatherQueueDisplayRun(queue) ?? completed ?? job!.run;
    if (job?.kind === "output" && job.run.phase !== "queued") {
      return { outcome: "started", run, queuedRunId: runId, position: 0 };
    }
    return {
      outcome: "queued",
      run,
      queuedRunId: runId,
      position: Math.max(1, requestedPosition)
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function resumePermissionJob(job: OutputGatherQueueJob, now: number): OutputGatherQueueJob {
  return {
    ...job,
    run: asOutputRun({
      ...job.run,
      phase: "queued",
      error: null,
      updatedAt: now,
      progress: { ...job.run.progress, message: "Folder access confirmed. Queued." }
    })
  };
}

function replaceJob(queue: GatherQueueState, job: OutputGatherQueueJob): GatherQueueState {
  return {
    ...queue,
    jobs: queue.jobs.map((candidate) => (candidate.run.id === job.run.id ? job : candidate))
  };
}

function recordAndRemove(queue: GatherQueueState, run: GatherRunState): GatherQueueState {
  return recordGatherQueueResult(
    { ...queue, jobs: queue.jobs.filter((job) => job.run.id !== run.id) },
    run
  );
}

function asCollectingRun(run: GatherRunState): CollectingGatherQueueJob["run"] {
  if (run.phase !== "collecting") {
    throw new Error(`Expected collecting Gather Run, received ${run.phase}.`);
  }
  return run as CollectingGatherQueueJob["run"];
}

function asOutputRun(run: GatherRunState): OutputGatherQueueJob["run"] {
  if (isTerminalGatherRunPhase(run.phase) || run.phase === "collecting") {
    throw new Error(`Expected executable Gather Run, received ${run.phase}.`);
  }
  return run as OutputGatherQueueJob["run"];
}
