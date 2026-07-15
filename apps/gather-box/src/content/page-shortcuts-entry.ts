import { installPageShortcuts, type PageShortcutSettings } from "./page-shortcuts";

const SETTINGS_KEY = "gather-box-settings";
let settings: PageShortcutSettings = { enabled: true };

installPageShortcuts(document, chrome.runtime, () => settings);
void refreshSettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes[SETTINGS_KEY]) {
    void refreshSettings();
  }
});

async function refreshSettings(): Promise<void> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as
    | { pageShortcutsEnabled?: unknown; shortcutsEnabled?: unknown }
    | undefined;
  settings = {
    enabled:
      value?.pageShortcutsEnabled === undefined && value?.shortcutsEnabled === undefined
        ? true
        : Boolean(value.pageShortcutsEnabled ?? value.shortcutsEnabled)
  };
}
