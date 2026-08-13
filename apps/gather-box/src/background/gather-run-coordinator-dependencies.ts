import { injectCollectorAndCollect } from "../gather/active-tab";
import {
  loadGatherQueue,
  saveGatherQueue,
  type GatherOutput,
  type GatherQueueState,
  type OutputGatherQueueJob
} from "../shared/gather-queue";
import { CANCEL_GATHER_RUN, EXECUTE_GATHER_RUN } from "../shared/gather-run-messages";
import type { GatherRunState } from "../shared/gather-run";
import { getGatherSource } from "../shared/source-catalog";
import { loadSettings, type GatherBoxSettings } from "../shared/settings";
import { OffscreenDocument } from "./offscreen-document";

export interface GatherRunCoordinatorDependencies {
  loadQueue(): Promise<GatherQueueState>;
  saveQueue(queue: GatherQueueState): Promise<void>;
  getActiveRunId(): Promise<string | null>;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  collect(tab: chrome.tabs.Tab, run: GatherRunState): Promise<GatherOutput>;
  loadSettings(): Promise<GatherBoxSettings>;
  execute(job: OutputGatherQueueJob): Promise<boolean>;
  abort(runId: string): Promise<boolean>;
  now(): number;
  randomUUID(): string;
}

export function createChromeCoordinatorDependencies(): GatherRunCoordinatorDependencies {
  const offscreenDocument = new OffscreenDocument();
  return {
    loadQueue: loadGatherQueue,
    saveQueue: saveGatherQueue,
    getActiveRunId: () => offscreenDocument.getActiveRunId(),
    getTab: (tabId) => chrome.tabs.get(tabId),
    collect: async (tab, run) => {
      const source = getGatherSource(run.siteKey);
      if (!source) {
        throw new Error("The Gather Source no longer has a collector adapter.");
      }
      const response = await injectCollectorAndCollect({
        tabId: tab.id!,
        pageUrl: run.tabUrl,
        requestId: run.id,
        source,
        onInjecting: () => undefined
      });
      if (!response || response.ok !== true) {
        throw new Error(response?.message || "The source page did not return collection data.");
      }
      return response;
    },
    loadSettings,
    execute: async (job) => {
      await offscreenDocument.ensure();
      const response = await chrome.runtime.sendMessage({
        type: EXECUTE_GATHER_RUN,
        target: "offscreen",
        runId: job.run.id,
        payload: job.payload,
        settings: job.settings
      });
      return response?.accepted === true;
    },
    abort: async (runId) => {
      if (!(await offscreenDocument.isOpen())) {
        return false;
      }
      const response = await chrome.runtime.sendMessage({
        type: CANCEL_GATHER_RUN,
        target: "offscreen",
        runId
      });
      return response?.aborted === true;
    },
    now: Date.now,
    randomUUID: () => crypto.randomUUID()
  };
}
