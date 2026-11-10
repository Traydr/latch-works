/**
 * Page shortcut script to service worker. The always-on script stays under its 10 kB budget, so
 * this module carries no Zod; the service worker parses these messages in
 * `background/page-shortcut-requests.ts`.
 */

export const TRIGGER_DOWNLOAD_MESSAGE = "GATHER_BOX_TRIGGER_DOWNLOAD";

export const OPEN_EXTENSION_MESSAGE = "GATHER_BOX_OPEN_EXTENSION";

export type PageShortcutRequest =
  | { type: typeof TRIGGER_DOWNLOAD_MESSAGE; target: "background" }
  | { type: typeof OPEN_EXTENSION_MESSAGE; target: "background" };
