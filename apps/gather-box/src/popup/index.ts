import { GatherController } from "../shared/gather-controller";
import { OPEN_SIDE_PANEL_MESSAGE } from "../shared/runtime-messages";
import { initLayoutSwitcher } from "./layout-switcher";
import { initPreviewSiteSwitcher, parsePreviewSiteKey } from "./preview-mode";
import type { SiteKey } from "../shared/sites";

document.addEventListener("DOMContentLoaded", () => {
  initLayoutSwitcher(document);

  const hashPreviewSite = parsePreviewSiteKey();
  const controller = new GatherController({
    includeOpenSidePanel: true,
    onOpenSidePanel: () => {
      void chrome.runtime.sendMessage({ type: OPEN_SIDE_PANEL_MESSAGE });
    },
    previewSiteKey: hashPreviewSite
  });

  const initialPreviewSite = hashPreviewSite ?? "kemono";
  initPreviewSiteSwitcher(document, (siteKey: SiteKey) => {
    controller.applyPreviewState(siteKey);
  }, initialPreviewSite);

  void controller.init(document);
});
