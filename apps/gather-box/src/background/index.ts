import {
  isGatherRunEventMessage,
  isRetryGatherRunRequest,
  isStartGatherRunRequest
} from "../shared/gather-run-messages";
import { markInterruptedGatherRun } from "../shared/gather-run-store";
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

chrome.runtime.onInstalled.addListener(() => {
  void configureExtensionUi();
  void setupContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void configureExtensionUi();
  void markInterruptedGatherRun();
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
    if (sender.tab || sender.id !== chrome.runtime.id) {
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
    if (sender.tab || sender.id !== chrome.runtime.id) {
      sendResponse({ outcome: "failed", message: "Untrusted Gather Run retry." });
      return false;
    }
    void gatherRuns.retry(message.runId).then(sendResponse);
    return true;
  }

  if (isGatherRunEventMessage(message)) {
    void gatherRuns.handleEvent(message);
    return false;
  }

  if (isResolveXMediaMessage(message)) {
    void resolveXPostMedia(message).then(sendResponse);
    return true;
  }

  if (isResolveRedgifsMediaMessage(message)) {
    void resolveRedgifsMedia(message.redgifsId).then(sendResponse);
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
