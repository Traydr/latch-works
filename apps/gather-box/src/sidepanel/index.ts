import { PanelController } from "./panel-controller";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new PanelController(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.windowId !== undefined) {
        return chrome.sidePanel.close({ windowId: tab.windowId });
      }

      return undefined;
    });
  });

  void controller.init(document);
});
