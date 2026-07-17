import {
  isCancelGatherRunRequest,
  isGatherRunEventMessage,
  isRetryGatherRunRequest,
  isStartGatherRunRequest
} from "../shared/gather-run-messages";
import { loadGatherRun, recoverInterruptedGatherRun } from "../shared/gather-run-store";
import { isTerminalGatherRunPhase } from "../shared/gather-run";
import {
  isPageGatherMessage,
  OPEN_EXTENSION_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE
} from "../shared/runtime-messages";
import { isResolveRedgifsMediaMessage } from "../shared/reddit-media";
import { getContextMenuMatches } from "../shared/source-catalog";
import { isResolveXMediaMessage } from "../shared/x-media";
import { GatherCommands } from "./gather-commands";
import { GatherRunCoordinator } from "./gather-run-coordinator";
import { resolveRedgifsMedia } from "./redgifs-media-resolver";
import { resolveXPostMedia } from "./x-media-resolver";

const CONTEXT_MENU_ID = "gather-box-download";
const gatherRuns = new GatherRunCoordinator();
const gatherCommands = new GatherCommands(gatherRuns);

// Recover non-terminal runs whenever the service worker wakes, not only on browser startup.
void recoverInterruptedGatherRun();

chrome.runtime.onInstalled.addListener(() => {
  void configureExtensionUi();
  void setupContextMenu();
  void recoverInterruptedGatherRun();
});

chrome.runtime.onStartup.addListener(() => {
  void configureExtensionUi();
  void recoverInterruptedGatherRun();
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
  if (isStartGatherRunRequest(message)) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run target." });
      return false;
    }
    void chrome.tabs
      .get(message.tabId)
      .then((tab) => gatherCommands.gather(tab))
      .then(sendResponse, (error) =>
        sendResponse({
          outcome: "failed",
          message: error instanceof Error ? error.message : "Could not start Gather Run."
        })
      );
    return true;
  }

  if (isRetryGatherRunRequest(message)) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run retry." });
      return false;
    }
    void gatherRuns.retry(message.runId).then(sendResponse);
    return true;
  }

  if (isCancelGatherRunRequest(message)) {
    if (!isExtensionOriginSender(sender)) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run cancel." });
      return false;
    }
    void gatherRuns.cancel(message.runId).then(sendResponse);
    return true;
  }

  if (isGatherRunEventMessage(message)) {
    if (!isExtensionOriginSender(sender)) {
      return false;
    }
    void gatherRuns.handleEvent(message);
    return false;
  }

  if (isResolveXMediaMessage(message)) {
    void authorizeMediaResolver(sender).then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, message: "Media resolution is only allowed for the active Gather Run tab." });
        return;
      }
      return resolveXPostMedia(message).then(sendResponse);
    });
    return true;
  }

  if (isResolveRedgifsMediaMessage(message)) {
    void authorizeMediaResolver(sender).then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, message: "Media resolution is only allowed for the active Gather Run tab." });
        return;
      }
      return resolveRedgifsMedia(message.redgifsId).then(sendResponse);
    });
    return true;
  }

  if (isPageGatherMessage(message) && sender.tab) {
    const operation =
      message.type === OPEN_EXTENSION_MESSAGE
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
  if (sender.id !== chrome.runtime.id || typeof sender.tab?.id !== "number") {
    return false;
  }

  const run = await loadGatherRun();
  if (!run || isTerminalGatherRunPhase(run.phase)) {
    return false;
  }

  return run.tabId === sender.tab.id && (run.phase === "collecting" || run.phase === "preparing");
}
