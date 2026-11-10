import {
  OPEN_EXTENSION_MESSAGE,
  type PageShortcutRequest,
  TRIGGER_DOWNLOAD_MESSAGE,
} from "../shared/protocol/page-shortcuts";
import { installShortcutKeyListener } from "../shared/shortcut-keys";

/** The background acknowledges these messages with a payload no page shortcut reads. */
interface RuntimeMessenger {
  sendMessage(message: PageShortcutRequest): Promise<void>;
}

export interface PageShortcutSettings {
  enabled: boolean;
}

export function installPageShortcuts(
  document: Document,
  runtime: RuntimeMessenger,
  getSettings: () => PageShortcutSettings,
): () => void {
  let uninstall: () => void = () => undefined;
  uninstall = installShortcutKeyListener(
    document,
    () => getSettings().enabled,
    (action) => {
      const message: PageShortcutRequest = {
        type: action === "toggle" ? OPEN_EXTENSION_MESSAGE : TRIGGER_DOWNLOAD_MESSAGE,
        target: "background",
      };

      try {
        void runtime.sendMessage(message).catch(uninstall);
      } catch {
        // An old content script survives an unpacked-extension reload. Stop intercepting the page
        // shortcut after the first invalid-context signal so later keys behave normally.
        uninstall();
      }
    },
  );

  return uninstall;
}
