import { initTrialStudio } from "./trial-studio";

document.addEventListener("DOMContentLoaded", () => {
  initTrialStudio({
    onToggleShortcut: () => {
      if (typeof chrome.sidePanel.close !== "function") {
        return;
      }

      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.windowId !== undefined) {
          return chrome.sidePanel.close({ windowId: tab.windowId });
        }
        return undefined;
      });
    }
  });
});
