import { GatherController } from "../shared/gather-controller";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new GatherController({
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
  void controller.init(document);
});
