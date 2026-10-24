import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

/** What the shell hands a mode's main side when it starts it. */
export interface ModeContext {
  /** The mode's own data folder: the one its standalone app used, `~/.latch-works/<app>`. */
  dataDir: string;
  window: () => BrowserWindow | null;
  /** Reports how far the mode's running work has got, from 0 to 1, or null once it has stopped. */
  onProgress: (progress: number | null) => void;
}

/** What a mode adds to the app menu while it is the mode on screen. */
export interface ModeMenu {
  /** Items at the top of File. */
  file: MenuItemConstructorOptions[];
  /** The whole Edit menu, for a mode that routes Undo and Select All itself. */
  edit?: MenuItemConstructorOptions[];
  /** Items after the modes in View. */
  view: MenuItemConstructorOptions[];
  /** Settings…: in the app menu on macOS, in File elsewhere. */
  settings?: MenuItemConstructorOptions;
  help: MenuItemConstructorOptions[];
}

/** A started mode, as the shell sees it. */
export interface ModeHost {
  /** Whether work the owner started is running, which closing the window must not cut short. */
  busy(): boolean;
  menu?: ModeMenu;
  /** Starts what the mode needs only once the owner first opens it: processes and windows. */
  activate?(): void;
  dispose?(): void;
}
