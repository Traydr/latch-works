import {
  CancelGatherRunRequestSchema,
  GatherRunEventMessageSchema,
  HandBackGatherFileRequestSchema,
  RetryGatherRunRequestSchema,
  StartGatherRunRequestSchema,
  type HandBackGatherFileOutcome
} from "../shared/gather-run-messages";
import { clearProfileDirectories } from "../gather/directory-store";
import { loadGatherQueue } from "../shared/gather-queue";
import {
  getRemovedProfileIds,
  GatherProfilesStateSchema,
  PROFILES_KEY
} from "../shared/profiles";
import { OPEN_EXTENSION_MESSAGE } from "../shared/runtime-messages";
import { GatherRuntimeMessageSchema } from "./page-messages";
import { ResolveRedgifsMediaMessageSchema } from "../shared/reddit-media";
import { getContextMenuMatches } from "../shared/source-catalog";
import { ResolveXMediaMessageSchema } from "../shared/x-media";
import { GatherCommands } from "./gather-commands";
import { GatherRunCoordinator } from "./gather-run-coordinator";
import { resolveRedgifsMedia } from "./redgifs-media-resolver";
import { resolveXPostMedia } from "./x-media-resolver";

const CONTEXT_MENU_ID = "gather-box-download";

const gatherRuns = new GatherRunCoordinator();

const gatherCommands = new GatherCommands(gatherRuns);

// Only recover on browser/extension startup. Do not mark interrupted on every service-worker
// wake: MV3 can suspend the worker while the offscreen document is still writing, and the next
// GATHER_RUN_EVENT would otherwise race recovery and drop live progress/complete events.
chrome.runtime.onInstalled.addListener(() => {
  void configureExtensionUi();
  void setupContextMenu();
  void gatherRuns.recover();
});

chrome.runtime.onStartup.addListener(() => {
  void configureExtensionUi();
  void gatherRuns.recover();
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
    GatherProfilesStateSchema.parse(change.newValue)
  );

  if (removed.length === 0) {
    return;
  }

  void gatherRuns.failDeletedProfileJobs();

  for (const profileId of removed) {
    void clearProfileDirectories(profileId);
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

  if (command === "toggle-gather-box") {
    void gatherCommands.toggle(tab);
  }

  if (command === "download-active-tab") {
    void gatherCommands.gather(tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const startRequest = StartGatherRunRequestSchema.safeParse(message);

  if (startRequest.success) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run target." });

      return false;
    }

    void chrome.tabs
      .get(startRequest.data.tabId)
      .then((tab) => gatherCommands.gather(tab, startRequest.data.profileId))
      .then(sendResponse, (error) =>
        sendResponse({
          outcome: "failed",
          message: error instanceof Error ? error.message : "Could not start Gather Run."
        })
      );

    return true;
  }

  const retryRequest = RetryGatherRunRequestSchema.safeParse(message);

  if (retryRequest.success) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run retry." });

      return false;
    }

    void gatherRuns
      .retry(retryRequest.data.runId, retryRequest.data.profileId)
      .then(sendResponse);

    return true;
  }

  const handBackRequest = HandBackGatherFileRequestSchema.safeParse(message);

  if (handBackRequest.success) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ recorded: false } satisfies HandBackGatherFileOutcome);

      return false;
    }

    const { runId, fileName, savedFileName } = handBackRequest.data;

    void gatherRuns.recordHandedBackFile({ runId, fileName, savedFileName }).then(
      (recorded) => sendResponse({ recorded } satisfies HandBackGatherFileOutcome),
      () => sendResponse({ recorded: false } satisfies HandBackGatherFileOutcome)
    );

    return true;
  }

  const cancelRequest = CancelGatherRunRequestSchema.safeParse(message);

  if (cancelRequest.success) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run cancel." });

      return false;
    }

    void gatherRuns.cancel(cancelRequest.data.runId).then(sendResponse);

    return true;
  }

  const runEvent = GatherRunEventMessageSchema.safeParse(message);

  if (runEvent.success) {
    if (!isExtensionOriginSender(sender)) {
      return false;
    }

    void gatherRuns.handleEvent(runEvent.data).then(
      () => sendResponse({ accepted: true }),
      (error) =>
        sendResponse({
          accepted: false,
          message: error instanceof Error ? error.message : "Could not persist Gather progress."
        })
    );

    return true;
  }

  const xMediaRequest = ResolveXMediaMessageSchema.safeParse(message);

  if (xMediaRequest.success) {
    void authorizeMediaResolver(sender).then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, message: "Media resolution is only allowed for the active Gather Run tab." });

        return;
      }

      return resolveXPostMedia(xMediaRequest.data).then(sendResponse);
    });

    return true;
  }

  const redgifsRequest = ResolveRedgifsMediaMessageSchema.safeParse(message);

  if (redgifsRequest.success) {
    void authorizeMediaResolver(sender).then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, message: "Media resolution is only allowed for the active Gather Run tab." });

        return;
      }

      return resolveRedgifsMedia(redgifsRequest.data.redgifsId).then(sendResponse);
    });

    return true;
  }

  const pageRequest = GatherRuntimeMessageSchema.safeParse(message);

  if (pageRequest.success && sender.tab) {
    const operation =
      pageRequest.data.type === OPEN_EXTENSION_MESSAGE
        ? gatherCommands.toggle(sender.tab)
        : gatherCommands.gather(sender.tab);

    void operation.then(sendResponse);

    return true;
  }

  return false;
});

async function configureExtensionUi(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

async function setupContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Gather to archive",
    contexts: ["page"],
    documentUrlPatterns: getContextMenuMatches()
  });
}

function isExtensionOriginSender(sender: chrome.runtime.MessageSender): boolean {
  return !sender.tab && sender.id === chrome.runtime.id;
}

async function authorizeMediaResolver(sender: chrome.runtime.MessageSender): Promise<boolean> {
  const senderTabId = sender.tab?.id;

  if (sender.id !== chrome.runtime.id || senderTabId === undefined) {
    return false;
  }

  const queue = await loadGatherQueue();

  return queue.jobs.some(
    (job) => job.run.tabId === senderTabId && job.run.phase === "collecting"
  );
}
