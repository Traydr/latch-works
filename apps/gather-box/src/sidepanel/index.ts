import { GatherController } from "../shared/gather-controller";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new GatherController({
    onToggleShortcut: () => {
      // chrome.sidePanel.close arrived in Chrome 127; older builds simply keep the panel open.
      if (!("close" in chrome.sidePanel)) {
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
