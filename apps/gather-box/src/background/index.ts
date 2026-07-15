import {
  APPLY_UI_MODE_MESSAGE,
  OPEN_EXTENSION_MESSAGE,
  OPEN_SIDE_PANEL_MESSAGE,
  PENDING_DOWNLOAD_SESSION_KEY,
  START_DOWNLOAD_MESSAGE,
  TOGGLE_OPEN_UI_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE
} from "../shared/runtime-messages";
import { isSupportedUrl } from "../shared/sites";
import { loadSettings, type PrimaryUiMode } from "../shared/settings";
import {
  applyPrimaryUiMode,
  openPrimaryUiForTab,
  openSidePanelForActiveTab
} from "../shared/ui-mode";
import { isResolveXMediaMessage } from "../shared/x-media";
import {
  isGatherRunEventMessage,
  isRetryGatherRunRequest,
  isStartGatherRunRequest
} from "../shared/gather-run-messages";
import { markInterruptedGatherRun } from "../shared/gather-run-store";
import { GatherRunCoordinator } from "./gather-run-coordinator";
import { resolveXPostMedia } from "./x-media-resolver";

const CONTEXT_MENU_ID = "gather-box-download";
const gatherRuns = new GatherRunCoordinator();

chrome.runtime.onInstalled.addListener(() => {
  void setupContextMenu();
  void applyPrimaryUiMode();
});

chrome.runtime.onStartup.addListener(() => {
  void applyPrimaryUiMode();
  void markInterruptedGatherRun();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab) {
    return;
  }

  void triggerDownload(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  void handleChromeCommand(command, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isStartGatherRunRequest(message)) {
    void chrome.tabs
      .get(message.tabId)
      .then((tab) => gatherRuns.startForTab(tab))
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          outcome: "failed",
          message: error instanceof Error ? error.message : "Could not start Gather Run."
        })
      );
    return true;
  }

  if (isRetryGatherRunRequest(message)) {
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

  if (message.type === APPLY_UI_MODE_MESSAGE) {
    void applyPrimaryUiMode();
    return;
  }

  if (message.type === OPEN_SIDE_PANEL_MESSAGE) {
    void openSidePanelForActiveTab();
  }

  if (message.type === OPEN_EXTENSION_MESSAGE && sender.tab) {
    void togglePrimaryUi(sender.tab, message.primaryUi);
  }

  if (message.type === TRIGGER_DOWNLOAD_MESSAGE && sender.tab) {
    void startDownloadFromShortcut(sender.tab, message.primaryUi);
  }

  return false;
});

async function setupContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Gather to archive",
    contexts: ["page"],
    documentUrlPatterns: [
      "https://myhentaigallery.com/a/*",
      "https://kemono.cr/*/user/*/post/*",
      "https://*.fanbox.cc/posts/*",
      "https://x.com/*/status/*",
      "https://www.pixiv.net/artworks/*",
      "https://www.pixiv.net/*/artworks/*",
      "https://archiveofourown.org/works/*",
      "https://www.hentai-foundry.com/stories/user/*",
      "https://www.fanfiction.net/s/*"
    ]
  });
}

async function handleChromeCommand(command: string, commandTab?: chrome.tabs.Tab): Promise<void> {
  if (command !== "toggle-gather-box" && command !== "download-active-tab") {
    return;
  }

  const settings = await loadSettings();
  if (!settings.shortcutsEnabled) {
    return;
  }

  const tab = commandTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) {
    return;
  }

  if (command === "toggle-gather-box") {
    await togglePrimaryUi(tab, settings.primaryUi);
    return;
  }

  await startDownloadFromShortcut(tab, settings.primaryUi);
}

async function triggerDownload(
  tab: chrome.tabs.Tab,
  primaryUi: PrimaryUiMode = "sidePanel"
): Promise<void> {
  if (!tab.url || !isSupportedUrl(tab.url)) {
    return;
  }

  const delivered = await deliverStartDownloadMessage();
  if (delivered) {
    return;
  }

  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [PENDING_DOWNLOAD_SESSION_KEY]: true });
    await openPrimaryUiForTab(tab, primaryUi);
  }
}

async function startDownloadFromShortcut(
  tab: chrome.tabs.Tab,
  primaryUi: PrimaryUiMode
): Promise<void> {
  if (!tab.url || !isSupportedUrl(tab.url) || tab.windowId === undefined) {
    return;
  }

  // Start both operations in the shortcut's user-gesture turn. The UI consumes the pending flag
  // during initialization and starts the same download action as its button. A currently-open UI
  // receives the direct request and acknowledges it, allowing the pending flag to be cleared.
  const pendingWrite = chrome.storage.session.set({ [PENDING_DOWNLOAD_SESSION_KEY]: true });
  const directDelivery = deliverStartDownloadMessage();
  const openingUi = openPrimaryUiForTab(tab, primaryUi);
  try {
    await Promise.all([pendingWrite, openingUi]);
    if (await directDelivery) {
      await chrome.storage.session.remove(PENDING_DOWNLOAD_SESSION_KEY);
    }
  } catch {
    await chrome.storage.session.remove(PENDING_DOWNLOAD_SESSION_KEY);
  }
}

async function togglePrimaryUi(tab: chrome.tabs.Tab, primaryUi: PrimaryUiMode): Promise<void> {
  // Do not await a state probe here: Chrome can expire the user gesture before sidePanel.open().
  // Opening is a no-op when the UI already exists; that instance receives the close request.
  await Promise.allSettled([
    deliverToggleUiMessage(),
    openPrimaryUiForTab(tab, primaryUi)
  ]);
}

async function deliverToggleUiMessage(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage<
      { type: typeof TOGGLE_OPEN_UI_MESSAGE },
      { accepted?: boolean } | undefined
    >({ type: TOGGLE_OPEN_UI_MESSAGE });
    return response?.accepted === true;
  } catch {
    return false;
  }
}

async function deliverStartDownloadMessage(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage<
      { type: typeof START_DOWNLOAD_MESSAGE },
      { accepted?: boolean } | undefined
    >({ type: START_DOWNLOAD_MESSAGE });
    return response?.accepted === true;
  } catch {
    return false;
  }
}
