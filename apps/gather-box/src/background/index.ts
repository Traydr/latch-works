import {
  APPLY_UI_MODE_MESSAGE,
  OPEN_SIDE_PANEL_MESSAGE,
  PENDING_DOWNLOAD_SESSION_KEY,
  START_DOWNLOAD_MESSAGE
} from "../shared/runtime-messages";
import { isSupportedUrl } from "../shared/sites";
import { applyPrimaryUiMode, openSidePanelForActiveTab } from "../shared/ui-mode";

const CONTEXT_MENU_ID = "gather-box-download";

chrome.runtime.onInstalled.addListener(() => {
  void setupContextMenu();
  void applyPrimaryUiMode();
});

chrome.runtime.onStartup.addListener(() => {
  void applyPrimaryUiMode();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab) {
    return;
  }

  void triggerDownload(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "download-active-tab") {
    return;
  }

  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await triggerDownload(tab);
    }
  })();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === APPLY_UI_MODE_MESSAGE) {
    void applyPrimaryUiMode();
    return;
  }

  if (message.type === OPEN_SIDE_PANEL_MESSAGE) {
    void openSidePanelForActiveTab();
  }
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
      "https://archiveofourown.org/works/*",
      "https://www.hentai-foundry.com/stories/user/*",
      "https://www.fanfiction.net/s/*"
    ]
  });
}

async function triggerDownload(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.url || !isSupportedUrl(tab.url)) {
    return;
  }

  const delivered = await deliverStartDownloadMessage();
  if (delivered) {
    return;
  }

  if (tab.windowId !== undefined) {
    await chrome.storage.session.set({ [PENDING_DOWNLOAD_SESSION_KEY]: true });
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

async function deliverStartDownloadMessage(): Promise<boolean> {
  try {
    await chrome.runtime.sendMessage({ type: START_DOWNLOAD_MESSAGE });
    return true;
  } catch {
    return false;
  }
}
