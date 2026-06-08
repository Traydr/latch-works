import { GatherController } from "../shared/gather-controller";
import { OPEN_SIDE_PANEL_MESSAGE } from "../shared/runtime-messages";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new GatherController({
    includeOpenSidePanel: true,
    onOpenSidePanel: () => {
      void chrome.runtime.sendMessage({ type: OPEN_SIDE_PANEL_MESSAGE });
    }
  });

  void controller.init(document);
});
