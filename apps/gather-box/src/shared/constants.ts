/**
 * Names shared by the runtime, the always-on page-shortcut script and `scripts/build.mjs`. This
 * module has no imports and no Zod, so the 10 kB page-shortcut entry can read it and Node can load
 * it with type stripping.
 */

export const SETTINGS_KEY = "gather-box-settings";

export const PROFILES_KEY = "gather-box-profiles";

export const GATHER_QUEUE_STATE_KEY = "gather-box-run-queue";

/** The `commands` keys declared in `manifest.base.json`; the build checks the two agree. */
export const COMMANDS = {
  toggle: "toggle-gather-box",
  download: "download-active-tab",
} as const;

export const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

export const OPTIONS_PAGE_PATH = "options/options.html";

export const AVIF_WORKER_PATH = "workers/avif-encoder.js";

export const AVIF_CODEC_PATH = "codecs/avif_enc.wasm";

export const STORY_FONT_PATHS = {
  regular: "assets/fonts/NotoSerif-Regular.ttf",
  italic: "assets/fonts/NotoSerif-Italic.ttf",
  bold: "assets/fonts/NotoSerif-Bold.ttf",
  boldItalic: "assets/fonts/NotoSerif-BoldItalic.ttf",
} as const;

export function collectorScriptPath(siteKey: string): string {
  return `content/collectors/${siteKey}.js`;
}

export const DOWNLOAD_CONCURRENCY = { default: 4, min: 1, max: 16 } as const;

/** The page-shortcut setting as stored; `shortcutsEnabled` is its name in older builds. */
export interface StoredPageShortcutSetting {
  pageShortcutsEnabled?: boolean;
  shortcutsEnabled?: boolean;
}

export function readPageShortcutsEnabled(stored: StoredPageShortcutSetting | undefined): boolean {
  return stored?.pageShortcutsEnabled ?? stored?.shortcutsEnabled ?? true;
}
