import type { GlazierBridge } from "./shared/bridge";

declare global {
  interface Window {
    glazier?: GlazierBridge;
  }
}
