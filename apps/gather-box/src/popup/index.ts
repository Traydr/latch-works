import { GatherController } from "../shared/gather-controller";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new GatherController({
    includeOpenSidePanel: true,
    onToggleShortcut: () => {
      window.close();
    },
    onOpenSidePanel: () => {
      void chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([tab]) => {
          if (tab?.windowId !== undefined) {
            return chrome.sidePanel.open({ windowId: tab.windowId });
          }
          return undefined;
        });
    }
  });

  void controller.init(document);
});
