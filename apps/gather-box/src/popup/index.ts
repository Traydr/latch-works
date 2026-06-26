import { GatherController } from "../shared/gather-controller";
import {
  getSelectedLayout,
  initSwitcher,
  renderLayoutInto
} from "../shared/layouts";

let controller: GatherController | null = null;

async function applyLayout(id: number): Promise<void> {
  controller?.destroy();
  controller = null;

  const root = document.getElementById("layout-root");
  if (!root) {
    return;
  }

  renderLayoutInto(id, root, { includeOpenSidePanel: true });

  controller = new GatherController({
    includeOpenSidePanel: true,
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

  await controller.init(document);
}

document.addEventListener("DOMContentLoaded", () => {
  initSwitcher((id) => {
    void applyLayout(id);
  });

  void (async () => {
    const id = await getSelectedLayout();
    await applyLayout(id);
  })();
});
