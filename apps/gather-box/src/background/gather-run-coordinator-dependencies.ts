import { getDirectoryDestinationId } from "../shared/directory-store";
import {
  type GatherQueueState,
  loadGatherQueue,
  type OutputGatherQueueJob,
  saveGatherQueue,
} from "../shared/gather-queue";
import type { FolderScope, GatherRunState } from "../shared/gather-run";
import type { ChannelFailure } from "../shared/messaging";
import { type GatherProfilesState, loadProfiles } from "../shared/profiles";
import {
  CANCEL_GATHER_RUN,
  EXECUTE_GATHER_RUN,
  type ExecutorResponses,
  sendExecutorRequest,
} from "../shared/protocol/executor";
import { type GatherBoxSettings, loadSettings } from "../shared/settings";
import type { MatchedPage } from "../shared/source-catalog";
import type { GatherOutput } from "../shared/types";
import { injectCollectorAndCollect } from "./collect";
import { type ExecutorStatus, OffscreenDocument } from "./offscreen-document";

export interface GatherRunCoordinatorDependencies {
  loadQueue(): Promise<GatherQueueState>;
  saveQueue(queue: GatherQueueState): Promise<void>;
  getExecutorStatus(): Promise<ExecutorStatus>;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  collect(tab: chrome.tabs.Tab, page: MatchedPage, run: GatherRunState): Promise<GatherOutput>;
  loadSettings(): Promise<GatherBoxSettings>;
  loadProfiles(): Promise<GatherProfilesState>;
  /** Which remembered folder an output queued now would be written to. */
  getDestinationId(scope: FolderScope, profileId: string): Promise<string | null>;
  execute(
    job: OutputGatherQueueJob,
  ): Promise<ExecutorResponses[typeof EXECUTE_GATHER_RUN] | ChannelFailure>;
  /** Whether the executor took the abort; false when it is not running this run. */
  abort(runId: string): Promise<boolean>;
  now(): number;
  randomUUID(): string;
}

export function createChromeCoordinatorDependencies(): GatherRunCoordinatorDependencies {
  const offscreenDocument = new OffscreenDocument();

  return {
    loadQueue: loadGatherQueue,
    saveQueue: saveGatherQueue,
    getExecutorStatus: () => offscreenDocument.getExecutorStatus(),
    getTab: (tabId) => chrome.tabs.get(tabId),
    collect: (tab, page, run) =>
      injectCollectorAndCollect(tab.id ?? run.tabId, page, {
        requestId: run.id,
        pageUrl: run.tabUrl,
      }),
    loadSettings,
    loadProfiles,
    getDestinationId: getDirectoryDestinationId,
    execute: async (job) => {
      await offscreenDocument.ensure();

      return sendExecutorRequest({
        type: EXECUTE_GATHER_RUN,
        target: "offscreen",
        runId: job.run.id,
        payload: job.payload,
        settings: job.settings,
        destinationId: job.destinationId,
        profileId: job.profileId,
      });
    },
    abort: async (runId) => {
      if (!(await offscreenDocument.isOpen())) {
        return false;
      }

      const response = await sendExecutorRequest({
        type: CANCEL_GATHER_RUN,
        target: "offscreen",
        runId,
      });

      return "aborted" in response && response.aborted;
    },
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
  };
}
