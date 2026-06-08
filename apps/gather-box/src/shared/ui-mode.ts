import { loadSettings } from "./settings";

const POPUP_PATH = "popup/popup.html";

export async function applyPrimaryUiMode(): Promise<void> {
  const settings = await loadSettings();

  if (settings.primaryUi === "sidePanel") {
    await chrome.action.setPopup({ popup: "" });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return;
  }

  await chrome.action.setPopup({ popup: POPUP_PATH });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

export async function openSidePanelForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}
