import { installPageShortcuts, type PageShortcutSettings } from "./page-shortcuts";

/**
 * This entry runs on every supported page, so it stays under a 10 kB budget and cannot pull in
 * the Zod settings schema. It reads the one field it needs off the record chrome.storage returns.
 */
interface StoredPageShortcutSettings {
  pageShortcutsEnabled?: boolean;
  /** Pre-rename name of `pageShortcutsEnabled`, still present in settings saved by old builds. */
  shortcutsEnabled?: boolean;
}

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
  // SAFETY: saveSettings in shared/settings.ts is the only writer of this key and always stores a
  // parsed GatherBoxSettings; both fields stay optional so a record from an older build reads too.
  const value = stored[SETTINGS_KEY] as StoredPageShortcutSettings | undefined;

  settings = { enabled: value?.pageShortcutsEnabled ?? value?.shortcutsEnabled ?? true };
}
