import type { BrowserWindow } from "electron";

/** What the shell hands a mode's main side when it starts it. */
export interface ModeContext {
  /** The mode's own data folder: the one its standalone app used, `~/.latch-works/<app>`. */
  dataDir: string;
  window: () => BrowserWindow | null;
  /** Reports how far the mode's running work has got, from 0 to 1, or null once it has stopped. */
  onProgress: (progress: number | null) => void;
}

/** A started mode, as the shell sees it. */
export interface ModeHost {
  /** Whether work the owner started is running, which closing the window must not cut short. */
  busy(): boolean;
}
