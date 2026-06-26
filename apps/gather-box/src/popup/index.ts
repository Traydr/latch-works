import { GatherController } from "../shared/gather-controller";
import { OPEN_SIDE_PANEL_MESSAGE } from "../shared/runtime-messages";
import { initLayoutSwitcher } from "./layout-switcher";
import { parsePreviewSiteKey } from "./preview-mode";

document.addEventListener("DOMContentLoaded", () => {
  initLayoutSwitcher(document);

  const previewSiteKey = parsePreviewSiteKey();
  const controller = new GatherController({
    includeOpenSidePanel: true,
    onOpenSidePanel: () => {
      void chrome.runtime.sendMessage({ type: OPEN_SIDE_PANEL_MESSAGE });
    },
    previewSiteKey
  });

  void controller.init(document);
});
