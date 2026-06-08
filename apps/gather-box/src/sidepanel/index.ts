import { GatherController } from "../shared/gather-controller";

document.addEventListener("DOMContentLoaded", () => {
  const controller = new GatherController();
  void controller.init(document);
});
