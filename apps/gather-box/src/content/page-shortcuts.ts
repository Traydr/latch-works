import {
  OPEN_EXTENSION_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE,
  type GatherRuntimeMessage
} from "../shared/runtime-messages";
import { installShortcutKeyListener } from "../shared/shortcut-keys";

/** The background acknowledges these messages with a payload no page shortcut reads. */
interface RuntimeMessenger {
  sendMessage(message: GatherRuntimeMessage): Promise<void>;
}

export interface PageShortcutSettings {
  enabled: boolean;
}

export function installPageShortcuts(
  document: Document,
  runtime: RuntimeMessenger = chrome.runtime,
  getSettings: () => PageShortcutSettings | null = () => ({ enabled: true })
): () => void {
  let uninstall: () => void = () => undefined;
  uninstall = installShortcutKeyListener(document, () => getSettings()?.enabled ?? false, (action) => {
    const settings = getSettings();
    if (!settings) {
      return;
    }

    const message: GatherRuntimeMessage = {
      type: action === "toggle" ? OPEN_EXTENSION_MESSAGE : TRIGGER_DOWNLOAD_MESSAGE,
      target: "background"
    };
    try {
      void runtime.sendMessage(message).catch(uninstall);
    } catch {
      // An old content script survives an unpacked-extension reload. Stop intercepting the page
      // shortcut after the first invalid-context signal so later keys behave normally.
      uninstall();
    }
  });
  return uninstall;
}
