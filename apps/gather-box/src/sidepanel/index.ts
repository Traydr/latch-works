import { GatherController } from "../shared/gather-controller";
import { initLayoutSwitcher } from "../popup/layout-switcher";
import { initPreviewSiteSwitcher, parsePreviewSiteKey } from "../popup/preview-mode";
import type { SiteKey } from "../shared/sites";

document.addEventListener("DOMContentLoaded", () => {
  initLayoutSwitcher(document);

  const hashPreviewSite = parsePreviewSiteKey();
  const controller = new GatherController({ previewSiteKey: hashPreviewSite });

  const initialPreviewSite = hashPreviewSite ?? "kemono";
  initPreviewSiteSwitcher(document, (siteKey: SiteKey) => {
    controller.applyPreviewState(siteKey);
  }, initialPreviewSite);

  void controller.init(document);
});
