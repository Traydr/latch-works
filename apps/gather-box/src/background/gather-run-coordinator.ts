import { injectCollectorAndCollect } from "../gather/active-tab";
import { formatError } from "../gather/errors";
import {
  createGatherRunState,
  isTerminalGatherRunPhase,
  type GatherRunStartOutcome,
  type GatherRunState
} from "../shared/gather-run";
import {
  EXECUTE_GATHER_RUN,
  type GatherRunEvent,
  type GatherRunEventMessage
} from "../shared/gather-run-messages";
import { loadGatherRun, saveGatherRun } from "../shared/gather-run-store";
import { saveLastRun } from "../shared/last-run";
import { getSiteKeyFromUrl, isSupportedUrl } from "../shared/sites";
import { getGatherSource } from "../shared/source-catalog";
import { loadSettings } from "../shared/settings";
import type { DownloadablePayload } from "../shared/types";
import { OffscreenDocument } from "./offscreen-document";

export class GatherRunCoordinator {
  private eventQueue = Promise.resolve();
  private offscreenDocument = new OffscreenDocument();
  private startQueue = Promise.resolve();

  startForTab(tab: chrome.tabs.Tab): Promise<GatherRunStartOutcome> {
    return this.serializeStart(() => this.start(tab));
  }

  async retry(runId: string): Promise<GatherRunStartOutcome> {
    return this.serializeStart(async () => {
      const previous = await loadGatherRun();
      if (!previous || previous.id !== runId || previous.retryImages.length === 0) {
        return { outcome: "failed", message: "No retryable Gather Run was found." };
      }
      const tab = await chrome.tabs.get(previous.tabId).catch(() => null);
      if (!tab) {
        return { outcome: "target-unavailable" };
      }
      return this.start(tab, {
        ok: true,
        outputKind: "downloadable-files",
        site: previous.siteKey,
        title: "Retry",
        pageUrl: previous.tabUrl,
        galleryId: null,
        folderSegments: previous.folderSegments,
        skippedCount: 0,
        images: previous.retryImages
      });
    });
  }

  handleEvent(message: GatherRunEventMessage): Promise<void> {
    const result = this.eventQueue.then(() => this.applyEventMessage(message));
    this.eventQueue = result.catch(() => undefined);
    return result;
  }

  private async applyEventMessage(message: GatherRunEventMessage): Promise<void> {
    const run = await loadGatherRun();
    if (!run || run.id !== message.runId || isTerminalGatherRunPhase(run.phase)) {
      return;
    }

    const updated = applyGatherRunEvent(run, message.event);
    await saveGatherRun(updated);
    if (isTerminalGatherRunPhase(updated.phase)) {
      await saveLastRun({
        timestamp: updated.updatedAt,
        siteKey: updated.siteKey,
        tabUrl: updated.tabUrl,
        destinationPreview: updated.destinationPreview,
        log: updated.log,
        failedItems: updated.failedItems,
        retryImages: updated.retryImages,
        canRetry: updated.retryImages.length > 0
      });
    }
  }

  private serializeStart(
    operation: () => Promise<GatherRunStartOutcome>
  ): Promise<GatherRunStartOutcome> {
    const result = this.startQueue.then(operation, operation);
    this.startQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async start(
    tab: chrome.tabs.Tab,
    retryPayload?: DownloadablePayload
  ): Promise<GatherRunStartOutcome> {
    if (typeof tab.id !== "number" || tab.windowId === undefined || !tab.url) {
      return { outcome: "target-unavailable" };
    }
    if (!isSupportedUrl(tab.url)) {
      return { outcome: "unsupported-source" };
    }

    const existing = await loadGatherRun();
    if (existing && !isTerminalGatherRunPhase(existing.phase)) {
      if (existing.phase === "permission-required" && existing.tabId === tab.id) {
        await saveGatherRun({
          ...existing,
          phase: "cancelled",
          updatedAt: Date.now(),
          progress: { ...existing.progress, message: "Superseded after folder access confirmation." }
        });
      } else {
        return { outcome: "already-running", run: existing };
      }
    }

    const siteKey = getSiteKeyFromUrl(tab.url);
    if (!siteKey) {
      return { outcome: "unsupported-source" };
    }
    let run = createGatherRunState({
      id: crypto.randomUUID(),
      tabId: tab.id,
      windowId: tab.windowId,
      tabUrl: tab.url,
      siteKey
    });
    await saveGatherRun(run);

    try {
      run = await this.patch(run, {
        phase: "collecting",
        log: [{ message: "Collecting content metadata..." }],
        progress: { ...run.progress, message: "Collecting content metadata..." }
      });
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.url || currentTab.url !== run.tabUrl || getSiteKeyFromUrl(currentTab.url) !== siteKey) {
        throw new Error("The source tab navigated before collection started.");
      }
      const source = getGatherSource(siteKey);
      if (!source) throw new Error("The Gather Source no longer has a collector adapter.");
      const response =
        retryPayload ??
        (await injectCollectorAndCollect({
          tabId: tab.id,
          pageUrl: run.tabUrl,
          requestId: run.id,
          source,
          onInjecting: () => {
            void this.appendLog(run.id, `Injecting the ${source.label} collector...`);
          }
        }));
      if (!response || response.ok !== true) {
        throw new Error(response?.message || "The source page did not return collection data.");
      }

      await this.offscreenDocument.ensure();
      const settings = await loadSettings();
      const accepted = await chrome.runtime.sendMessage({
        type: EXECUTE_GATHER_RUN,
        target: "offscreen",
        runId: run.id,
        payload: response,
        settings
      });
      if (accepted?.accepted !== true) {
        throw new Error("The Gather executor did not accept the run.");
      }
      return { outcome: "started", run: (await loadGatherRun()) ?? run };
    } catch (error) {
      const failed = await this.patch(run, {
        phase: "failed",
        error: formatError(error),
        log: [...run.log, { message: formatError(error), tone: "error" }],
        progress: { ...run.progress, message: "Gather Run failed." }
      });
      return { outcome: "failed", message: failed.error ?? "Gather Run failed." };
    }
  }

  private async patch(
    run: GatherRunState,
    patch: Partial<GatherRunState>
  ): Promise<GatherRunState> {
    const updated: GatherRunState = { ...run, ...patch, updatedAt: Date.now() };
    await saveGatherRun(updated);
    return updated;
  }

  private async appendLog(runId: string, message: string): Promise<void> {
    const run = await loadGatherRun();
    if (!run || run.id !== runId) {
      return;
    }
    await saveGatherRun({
      ...run,
      updatedAt: Date.now(),
      log: [...run.log, { message }]
    });
  }
}

export function applyGatherRunEvent(
  run: GatherRunState,
  event: GatherRunEvent,
  now = Date.now()
): GatherRunState {
  const updatedAt = now;
  if (event.kind === "permission-required") {
    return {
      ...run,
      updatedAt,
      phase: "permission-required",
      error: null,
      progress: { ...run.progress, message: "Folder access needs confirmation in Gather Box." },
      log: [...run.log, { message: "Confirm folder access to continue.", tone: "error" }]
    };
  }
  if (event.kind === "writing") {
    return {
      ...run,
      updatedAt,
      phase: "writing",
      destinationPreview: event.destinationPreview,
      folderSegments: event.folderSegments,
      progress: { ...run.progress, total: event.total, message: "Writing Gather Output..." }
    };
  }
  if (event.kind === "progress") {
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
  }
  if (event.kind === "log") {
    return { ...run, updatedAt, log: [...run.log, event] };
  }
  if (event.kind === "failed") {
    return {
      ...run,
      updatedAt,
      phase: "failed",
      error: event.message,
      progress: { ...run.progress, message: "Gather Run failed." },
      log: [...run.log, { message: event.message, tone: "error" }]
    };
  }
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
      message: `Complete. Saved ${event.saved}, skipped ${event.skipped}, failed ${event.failed}.`
    }
  };
}
