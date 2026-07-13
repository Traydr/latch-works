import {
  OPEN_EXTENSION_MESSAGE,
  TRIGGER_DOWNLOAD_MESSAGE,
  type GatherRuntimeMessage
} from "../shared/runtime-messages";
import type { PrimaryUiMode } from "../shared/settings";
import { installShortcutKeyListener } from "../shared/shortcut-keys";

interface RuntimeMessenger {
  sendMessage(message: GatherRuntimeMessage): Promise<unknown>;
}

export interface PageShortcutSettings {
  enabled: boolean;
  primaryUi: PrimaryUiMode;
}

export function installPageShortcuts(
  document: Document,
  runtime: RuntimeMessenger = chrome.runtime,
  getSettings: () => PageShortcutSettings | null = () => ({
    enabled: true,
    primaryUi: "popup"
  })
): () => void {
  return installShortcutKeyListener(document, () => getSettings()?.enabled ?? false, (action) => {
    const settings = getSettings();
    if (!settings) {
      return;
    }

    const message: GatherRuntimeMessage =
      action === "toggle"
        ? { type: OPEN_EXTENSION_MESSAGE, primaryUi: settings.primaryUi }
        : { type: TRIGGER_DOWNLOAD_MESSAGE, primaryUi: settings.primaryUi };
    try {
      void runtime.sendMessage(message).catch(() => {
        // The extension may be reloading while the page's old content script is still present.
      });
    } catch {
      // sendMessage throws synchronously after an unpacked extension is reloaded. The stale page
      // listener cannot remove itself because its extension context no longer exists.
    }
  });
}
