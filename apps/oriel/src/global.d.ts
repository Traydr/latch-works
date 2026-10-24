import type { OrielBridge } from "./shared/shell";

declare global {
  interface Window {
    oriel?: OrielBridge;
  }
}
