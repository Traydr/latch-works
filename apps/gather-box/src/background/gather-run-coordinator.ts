import { injectCollectorAndCollect } from "../gather/active-tab";
import { formatError } from "../gather/errors";
import {
  getExecutingGatherJob,
  getGatherQueueDisplayRun,
  getNextQueuedGatherJob,
  loadGatherQueue,
  MAX_GATHER_QUEUE_LENGTH,
  recoverStoppedGatherQueue,
  saveGatherQueue,
  type GatherOutput,
  type GatherQueueJob,
  type GatherQueueState
} from "../shared/gather-queue";
import {
  CANCEL_GATHER_RUN,
  EXECUTE_GATHER_RUN,
  type GatherRunCancelOutcome,
  type GatherRunEvent,
  type GatherRunEventMessage
} from "../shared/gather-run-messages";
import {
  createGatherRunState,
  isTerminalGatherRunPhase,
  type GatherRunStartOutcome,
  type GatherRunState
} from "../shared/gather-run";
import { loadGatherRun, saveGatherRun } from "../shared/gather-run-store";
import { saveLastRun } from "../shared/last-run";
import { getSiteKeyFromUrl, isSupportedUrl } from "../shared/sites";
import { getGatherSource } from "../shared/source-catalog";
import { loadSettings, type GatherBoxSettings } from "../shared/settings";
import type { DownloadablePayload } from "../shared/types";
import { OffscreenDocument } from "./offscreen-document";

export class GatherRunCoordinator {
  private operationQueue = Promise.resolve();
  private readonly offscreenDocument = new OffscreenDocument();

  startForTab(tab: chrome.tabs.Tab): Promise<GatherRunStartOutcome> {
    return this.serialize(async () => {
      await this.recoverStoppedWork();
      return this.enqueueFromTab(tab);
    });
  }

  retry(runId: string): Promise<GatherRunStartOutcome> {
    return this.serialize(async () => {
      await this.recoverStoppedWork();
      const previous = await loadGatherRun();
      if (!previous || previous.id !== runId || previous.retryImages.length === 0) {
        return { outcome: "failed", message: "No retryable Gather Run was found." };
      }

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
      return this.enqueueCollectedOutput(previous, payload, await loadSettings());
    });
  }

  cancel(runId: string): Promise<GatherRunCancelOutcome> {
    return this.serialize(async () => {
      await this.recoverStoppedWork();
      let queue = await loadGatherQueue();
      const job = queue.jobs.find((candidate) => candidate.run.id === runId);
      if (!job) {
        return { outcome: "idle" };
      }

      if (
        job.run.phase === "preparing" ||
        job.run.phase === "writing" ||
        job.run.phase === "permission-required"
      ) {
        try {
          await this.offscreenDocument.ensure();
          await chrome.runtime.sendMessage({
            type: CANCEL_GATHER_RUN,
            target: "offscreen",
            runId
          });
        } catch {
          // A missing executor is equivalent to an already-stopped job.
        }
      }

      const cancelled = applyGatherRunEvent(job.run, {
        kind: "cancelled",
        message: "Gather Run cancelled."
      });
      queue = removeGatherJob(queue, runId);
      await this.persistQueue(queue, cancelled);
      await persistLastRun(cancelled);
      await this.pump(queue);
      return { outcome: "cancelled", run: cancelled };
    });
  }

  handleEvent(message: GatherRunEventMessage): Promise<void> {
    return this.serialize(() => this.applyEventMessage(message));
  }

  recover(): Promise<void> {
    return this.serialize(() => this.recoverStoppedWork());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async recoverStoppedWork(): Promise<void> {
    let queue = await loadGatherQueue();
    if (queue.jobs.length === 0) {
      return;
    }

    const activeRunIds = new Set(await this.offscreenDocument.getActiveRunIds());
    if (queue.jobs.some((job) => activeRunIds.has(job.run.id))) {
      await this.persistQueue(queue);
      return;
    }

    const recovered = recoverStoppedGatherQueue(queue);
    queue = recovered.queue;
    for (const interrupted of recovered.interrupted) {
      await persistLastRun(interrupted);
    }
    await this.persistQueue(queue, recovered.interrupted.at(-1) ?? null);
    await this.pump(queue);
  }

  private async enqueueFromTab(tab: chrome.tabs.Tab): Promise<GatherRunStartOutcome> {
    if (typeof tab.id !== "number" || tab.windowId === undefined || !tab.url) {
      return { outcome: "target-unavailable" };
    }
    if (!isSupportedUrl(tab.url)) {
      return { outcome: "unsupported-source" };
    }
    const tabUrl = tab.url;

    let queue = await loadGatherQueue();
    const permissionJob = queue.jobs.find(
      (job) =>
        job.run.phase === "permission-required" &&
        job.run.tabId === tab.id &&
        (job.settings?.useGlobalFolder === true || job.run.siteKey === getSiteKeyFromUrl(tabUrl))
    );
    if (permissionJob) {
      permissionJob.run = {
        ...permissionJob.run,
        phase: "queued",
        error: null,
        updatedAt: Date.now(),
        progress: { ...permissionJob.run.progress, message: "Folder access confirmed. Queued." }
      };
      await this.persistQueue(queue);
      queue = await this.pump(queue);
      return this.outcomeForJob(queue, permissionJob.run.id, 0);
    }

    const duplicateJob = queue.jobs.find((job) => job.run.tabUrl === tabUrl);
    if (duplicateJob) {
      const position = queue.jobs.findIndex((job) => job.run.id === duplicateJob.run.id);
      return this.outcomeForJob(queue, duplicateJob.run.id, position);
    }

    if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
      return {
        outcome: "failed",
        message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
      };
    }

    const siteKey = getSiteKeyFromUrl(tab.url);
    if (!siteKey) {
      return { outcome: "unsupported-source" };
    }

    let run: GatherRunState = {
      ...createGatherRunState({
        id: crypto.randomUUID(),
        tabId: tab.id,
        windowId: tab.windowId,
        tabUrl: tab.url,
        siteKey
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
    };
    const job: GatherQueueJob = { run, payload: null, settings: null };
    queue = { ...queue, jobs: [...queue.jobs, job] };
    await this.persistQueue(queue);

    try {
      const currentTab = await chrome.tabs.get(tab.id);
      if (
        !currentTab.url ||
        currentTab.url !== run.tabUrl ||
        getSiteKeyFromUrl(currentTab.url) !== siteKey
      ) {
        throw new Error("The source tab navigated before collection started.");
      }

      const source = getGatherSource(siteKey);
      if (!source) {
        throw new Error("The Gather Source no longer has a collector adapter.");
      }
      const response = await injectCollectorAndCollect({
        tabId: tab.id,
        pageUrl: run.tabUrl,
        requestId: run.id,
        source,
        onInjecting: () => undefined
      });
      if (!response || response.ok !== true) {
        throw new Error(response?.message || "The source page did not return collection data.");
      }

      const settings = await loadSettings();
      const total =
        response.outputKind === "generated-story-pdf"
          ? response.chapters.length
          : response.images.length;
      run = {
        ...run,
        phase: "queued",
        updatedAt: Date.now(),
        folderSegments: response.folderSegments,
        progress: { ...run.progress, total, message: `Queued "${response.title}".` },
        log: [
          ...run.log,
          { message: `Queued ${total} item(s) from "${response.title}".`, tone: "success" }
        ]
      };
      job.run = run;
      job.payload = response;
      job.settings = settings;

      const active = getExecutingGatherJob(queue);
      if (active && active.run.id !== run.id) {
        active.run = {
          ...active.run,
          log: [
            ...active.run.log,
            { message: `Queued "${response.title}" for background processing.`, tone: "success" }
          ]
        };
      }

      const position = queue.jobs.filter(
        (candidate) =>
          candidate.run.id !== run.id &&
          !isTerminalGatherRunPhase(candidate.run.phase)
      ).length;
      await this.persistQueue(queue);
      queue = await this.pump(queue);
      return this.outcomeForJob(queue, run.id, position);
    } catch (error) {
      const failed = applyGatherRunEvent(run, { kind: "failed", message: formatError(error) });
      queue = removeGatherJob(queue, run.id);
      await this.persistQueue(queue, failed);
      await persistLastRun(failed);
      await this.pump(queue);
      return { outcome: "failed", message: failed.error ?? "Gather Run failed." };
    }
  }

  private async enqueueCollectedOutput(
    previous: GatherRunState,
    payload: GatherOutput,
    settings: GatherBoxSettings
  ): Promise<GatherRunStartOutcome> {
    let queue = await loadGatherQueue();
    if (queue.jobs.length >= MAX_GATHER_QUEUE_LENGTH) {
      return {
        outcome: "failed",
        message: `The Gather queue is full (${MAX_GATHER_QUEUE_LENGTH} items).`
      };
    }

    const run: GatherRunState = {
      ...createGatherRunState({
        id: crypto.randomUUID(),
        tabId: previous.tabId,
        windowId: previous.windowId,
        tabUrl: previous.tabUrl,
        siteKey: previous.siteKey
      }),
      phase: "queued",
      folderSegments: payload.folderSegments,
      progress: {
        completed: 0,
        total:
          payload.outputKind === "downloadable-files"
            ? payload.images.length
            : payload.chapters.length,
        saved: 0,
        skipped: 0,
        failed: 0,
        message: `Queued "${payload.title}".`
      },
      log: [{ message: `Queued retry for ${previous.retryImages.length} failed item(s).` }]
    };
    const position = queue.jobs.length;
    queue = { ...queue, jobs: [...queue.jobs, { run, payload, settings }] };
    await this.persistQueue(queue);
    queue = await this.pump(queue);
    return this.outcomeForJob(queue, run.id, position);
  }

  private async applyEventMessage(message: GatherRunEventMessage): Promise<void> {
    let queue = await loadGatherQueue();
    const job = queue.jobs.find((candidate) => candidate.run.id === message.runId);
    if (!job || isTerminalGatherRunPhase(job.run.phase)) {
      return;
    }

    const updated = applyGatherRunEvent(job.run, message.event);
    if (isTerminalGatherRunPhase(updated.phase)) {
      queue = removeGatherJob(queue, updated.id);
      await this.persistQueue(queue, updated);
      await persistLastRun(updated);
      await this.pump(queue);
      return;
    }

    job.run = updated;
    await this.persistQueue(queue);
  }

  private async pump(queue: GatherQueueState): Promise<GatherQueueState> {
    if (getExecutingGatherJob(queue)) {
      await this.persistQueue(queue);
      return queue;
    }

    const job = getNextQueuedGatherJob(queue);
    if (!job || !job.payload || !job.settings) {
      await this.persistQueue(queue);
      return queue;
    }

    job.run = {
      ...job.run,
      phase: "preparing",
      updatedAt: Date.now(),
      progress: { ...job.run.progress, completed: 0, message: "Starting queued Gather Output..." }
    };
    await this.persistQueue(queue);

    try {
      await this.offscreenDocument.ensure();
      const accepted = await chrome.runtime.sendMessage({
        type: EXECUTE_GATHER_RUN,
        target: "offscreen",
        runId: job.run.id,
        payload: job.payload,
        settings: job.settings
      });
      if (accepted?.accepted !== true) {
        throw new Error("The Gather executor did not accept the queued output.");
      }
      return queue;
    } catch (error) {
      const failed = applyGatherRunEvent(job.run, {
        kind: "failed",
        message: formatError(error)
      });
      const remaining = removeGatherJob(queue, job.run.id);
      await this.persistQueue(remaining, failed);
      await persistLastRun(failed);
      return this.pump(remaining);
    }
  }

  private outcomeForJob(
    queue: GatherQueueState,
    queuedRunId: string,
    requestedPosition: number
  ): GatherRunStartOutcome {
    const job = queue.jobs.find((candidate) => candidate.run.id === queuedRunId);
    if (!job) {
      return { outcome: "failed", message: "The queued Gather Run could not be restored." };
    }
    const display = getGatherQueueDisplayRun(queue) ?? job.run;

    if (job?.run.phase === "preparing" || job?.run.phase === "writing") {
      return { outcome: "started", run: display, queuedRunId, position: 0 };
    }

    return {
      outcome: "queued",
      run: display,
      queuedRunId,
      position: Math.max(1, requestedPosition)
    };
  }

  private async persistQueue(
    queue: GatherQueueState,
    fallbackRun: GatherRunState | null = null
  ): Promise<void> {
    await saveGatherQueue(queue);
    const display = getGatherQueueDisplayRun(queue) ?? fallbackRun;
    if (display) {
      await saveGatherRun(display);
    }
  }
}

function removeGatherJob(queue: GatherQueueState, runId: string): GatherQueueState {
  return { ...queue, jobs: queue.jobs.filter((job) => job.run.id !== runId) };
}

async function persistLastRun(run: GatherRunState): Promise<void> {
  await saveLastRun({
    timestamp: run.updatedAt,
    siteKey: run.siteKey,
    tabUrl: run.tabUrl,
    destinationPreview: run.destinationPreview,
    log: run.log,
    failedItems: run.failedItems,
    retryImages: run.retryImages,
    canRetry: run.retryImages.length > 0
  });
}

export function applyGatherRunEvent(
  run: GatherRunState,
  event: GatherRunEvent,
  now = Date.now()
): GatherRunState {
  const updatedAt = now;
  switch (event.kind) {
    case "permission-required":
      return {
        ...run,
        updatedAt,
        phase: "permission-required",
        error: null,
        progress: { ...run.progress, message: "Folder access needs confirmation in Gather Box." },
        log: [...run.log, { message: "Confirm folder access to continue.", tone: "error" }]
      };
    case "writing":
      return {
        ...run,
        updatedAt,
        phase: "writing",
        destinationPreview: event.destinationPreview,
        folderSegments: event.folderSegments,
        progress: { ...run.progress, total: event.total, message: "Writing Gather Output..." }
      };
    case "progress":
      return {
        ...run,
        updatedAt,
        progress: {
          ...run.progress,
          completed: event.completed,
          total: event.total,
          message: event.message
        }
      };
    case "log":
      return { ...run, updatedAt, log: [...run.log, event] };
    case "failed":
      return {
        ...run,
        updatedAt,
        phase: "failed",
        error: event.message,
        progress: { ...run.progress, message: "Gather Run failed." },
        log: [...run.log, { message: event.message, tone: "error" }]
      };
    case "cancelled":
      return {
        ...run,
        updatedAt,
        phase: "cancelled",
        error: event.message ?? "Gather Run cancelled.",
        progress: { ...run.progress, message: "Gather Run cancelled." },
        log: [...run.log, { message: event.message ?? "Gather Run cancelled.", tone: "error" }]
      };
    case "complete":
      return {
        ...run,
        updatedAt,
        phase: event.failed > 0 ? "failed" : "complete",
        error: event.failed > 0 ? `${event.failed} item(s) failed.` : null,
        failedItems: event.failedItems,
        retryImages: event.retryImages,
        progress: {
          ...run.progress,
          completed: run.progress.total,
          saved: event.saved,
          skipped: event.skipped,
          failed: event.failed,
          message:
            `Complete. Saved ${event.saved}, skipped ${event.skipped}, ` +
            `failed ${event.failed}.`
        }
      };
    default: {
      const unknownKind = (event as { kind?: unknown }).kind;
      throw new Error(`Rejected unknown Gather Run event kind: ${String(unknownKind)}`);
    }
  }
}
