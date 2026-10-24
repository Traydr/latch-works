import type { LockstepApi } from "./shared/types";

declare global {
  interface Window {
    lockstep?: LockstepApi;
  }
}
