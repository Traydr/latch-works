import { COMMANDS, PROFILES_KEY } from "../shared/constants";
import { clearProfileDirectories } from "../shared/directory-store";
import { toError } from "../shared/errors";
import { loadGatherQueue } from "../shared/gather-queue";
import type { GatherRunStartOutcome } from "../shared/gather-run";
import {
  answerChannel,
  type ChannelFailure,
  failChannel,
  isExtensionPageSender,
  listenOnChannels,
} from "../shared/messaging";
import { GatherProfilesStateSchema, getRemovedProfileIds } from "../shared/profiles";
import {
  type CollectorRequest,
  CollectorRequestSchema,
  type CollectorResponses,
  type FailedCollectorRequest,
  failCollectorRequest,
  RESOLVE_REDGIFS_MEDIA_MESSAGE,
  RESOLVE_X_MEDIA_MESSAGE,
} from "../shared/protocol/collector";
import {
  OPEN_EXTENSION_MESSAGE,
  type PageShortcutRequest,
  TRIGGER_DOWNLOAD_MESSAGE,
} from "../shared/protocol/page-shortcuts";
import {
  CANCEL_GATHER_RUN_REQUEST,
  HAND_BACK_GATHER_FILE_REQUEST,
  type PanelRequest,
  PanelRequestSchema,
  type PanelResponses,
  RETRY_GATHER_RUN_REQUEST,
  START_GATHER_RUN_REQUEST,
} from "../shared/protocol/panel";
import {
  GATHER_RUN_EVENT,
  type GatherRunEventMessage,
  GatherRunEventMessageSchema,
  type RunEventResponses,
} from "../shared/protocol/run-events";
import { getPageMatches } from "../shared/source-catalog";
import { GatherCommands, type ToggleGatherBoxOutcome } from "./gather-commands";
import { GatherRunCoordinator } from "./gather-run-coordinator";
import { PageShortcutRequestSchema } from "./page-shortcut-requests";
import { resolveRedgifsMedia } from "./redgifs-media-resolver";
import { resolveXPostMedia } from "./x-media-resolver";

const CONTEXT_MENU_ID = "gather-box-download";

const gatherRuns = new GatherRunCoordinator();

const gatherCommands = new GatherCommands(gatherRuns);

// Only recover on browser/extension startup. Do not mark interrupted on every service-worker
// wake: MV3 can suspend the worker while the offscreen document is still writing, and the next
// GATHER_RUN_EVENT would otherwise race recovery and drop live progress/complete events.
chrome.runtime.onInstalled.addListener(() => {
  runInBackground("set up the toolbar button", configureExtensionUi());
  runInBackground("set up the context menu", setupContextMenu());
  runInBackground("recover the Gather queue", gatherRuns.recover());
});

chrome.runtime.onStartup.addListener(() => {
  runInBackground("set up the toolbar button", configureExtensionUi());
  runInBackground("recover the Gather queue", gatherRuns.recover());
});

// Profiles are deleted from the settings page or on another synced device. Either way this
// browser forgets the deleted profiles' folders and ends the outputs still waiting on them.
chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = areaName === "sync" ? changes[PROFILES_KEY] : undefined;

  if (!change) {
    return;
  }

  const removed = getRemovedProfileIds(
    GatherProfilesStateSchema.parse(change.oldValue),
    GatherProfilesStateSchema.parse(change.newValue),
  );

  if (removed.length === 0) {
    return;
  }

  runInBackground("end a deleted profile's outputs", gatherRuns.failDeletedProfileJobs());

  for (const profileId of removed) {
    runInBackground("forget a deleted profile's folders", clearProfileDirectories(profileId));
  }
});

chrome.sidePanel.onOpened.addListener((info) => {
  gatherCommands.panelOpened(info.windowId);
});

chrome.sidePanel.onClosed.addListener((info) => {
  gatherCommands.panelClosed(info.windowId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && tab) {
    void gatherCommands.gather(tab);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) {
    return;
  }

  if (command === COMMANDS.toggle) {
    void gatherCommands.toggle(tab);
  }

  if (command === COMMANDS.download) {
    void gatherCommands.gather(tab);
  }
});

const refuseUnlessExtensionPage = (sender: chrome.runtime.MessageSender) =>
  isExtensionPageSender(sender) ? null : "Only Gather Box pages may send this request.";

interface PageShortcutResponses {
  [OPEN_EXTENSION_MESSAGE]: ToggleGatherBoxOutcome;
  [TRIGGER_DOWNLOAD_MESSAGE]: GatherRunStartOutcome;
}

listenOnChannels(
  answerChannel<PanelRequest, PanelResponses, ChannelFailure>({
    schema: PanelRequestSchema,
    refuse: refuseUnlessExtensionPage,
    fail: failChannel,
    handlers: {
      [START_GATHER_RUN_REQUEST]: async (request) =>
        gatherCommands.gather(await chrome.tabs.get(request.tabId), request.profileId),
      [RETRY_GATHER_RUN_REQUEST]: (request) => gatherRuns.retry(request.runId, request.profileId),
      [CANCEL_GATHER_RUN_REQUEST]: (request) => gatherRuns.cancel(request.runId),
      [HAND_BACK_GATHER_FILE_REQUEST]: async ({ runId, fileName, savedFileName }) =>
        (await gatherRuns.recordHandedBackFile({ runId, fileName, savedFileName }))
          ? { outcome: "recorded" }
          : { outcome: "not-listed" },
    },
  }),
  answerChannel<GatherRunEventMessage, RunEventResponses, ChannelFailure>({
    schema: GatherRunEventMessageSchema,
    refuse: refuseUnlessExtensionPage,
    fail: failChannel,
    handlers: {
      [GATHER_RUN_EVENT]: async (message) => {
        await gatherRuns.handleEvent(message);

        return { outcome: "accepted" };
      },
    },
  }),
  answerChannel<CollectorRequest, CollectorResponses, FailedCollectorRequest>({
    schema: CollectorRequestSchema,
    refuse: refuseUnlessCollectingTab,
    fail: failCollectorRequest,
    handlers: {
      [RESOLVE_X_MEDIA_MESSAGE]: (request) => resolveXPostMedia(request),
      [RESOLVE_REDGIFS_MEDIA_MESSAGE]: (request) => resolveRedgifsMedia(request.redgifsId),
    },
  }),
  answerChannel<PageShortcutRequest, PageShortcutResponses, ChannelFailure>({
    schema: PageShortcutRequestSchema,
    refuse: (sender) => (sender.tab ? null : "Page shortcuts come from a page."),
    fail: failChannel,
    handlers: {
      [OPEN_EXTENSION_MESSAGE]: (_request, sender) => gatherCommands.toggle(senderTab(sender)),
      [TRIGGER_DOWNLOAD_MESSAGE]: (_request, sender) => gatherCommands.gather(senderTab(sender)),
    },
  }),
);

async function configureExtensionUi(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function setupContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Gather to archive",
    contexts: ["page"],
    documentUrlPatterns: getPageMatches(),
  });
}

/** Media resolution runs only for a page whose collector this service worker injected. */
async function refuseUnlessCollectingTab(
  sender: chrome.runtime.MessageSender,
): Promise<string | null> {
  const senderTabId = sender.tab?.id;
  const refusal = "Media resolution is only allowed for the active Gather Run tab.";

  if (sender.id !== chrome.runtime.id || senderTabId === undefined) {
    return refusal;
  }

  const queue = await loadGatherQueue();

  const collecting = queue.jobs.some(
    (job) => job.run.tabId === senderTabId && job.run.phase === "collecting",
  );

  return collecting ? null : refusal;
}

/** The service worker's console is the only place a failure without a requester can go. */
function runInBackground(task: string, work: Promise<void>): void {
  work.catch((error) => console.error(`Gather Box could not ${task}:`, toError(error)));
}

function senderTab(sender: chrome.runtime.MessageSender): chrome.tabs.Tab {
  if (!sender.tab) {
    throw new Error("Page shortcuts come from a page.");
  }

  return sender.tab;
}
