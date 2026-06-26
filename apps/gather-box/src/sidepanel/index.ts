import { GatherController } from "../shared/gather-controller";
import { initLayoutSwitcher } from "../popup/layout-switcher";
import { parsePreviewSiteKey } from "../popup/preview-mode";

document.addEventListener("DOMContentLoaded", () => {
  initLayoutSwitcher(document);

  const previewSiteKey = parsePreviewSiteKey();
  const controller = new GatherController({ previewSiteKey });

  void controller.init(document);
});
