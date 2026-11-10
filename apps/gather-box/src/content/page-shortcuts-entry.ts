import {
  readPageShortcutsEnabled,
  SETTINGS_KEY,
  type StoredPageShortcutSetting,
} from "../shared/constants";
import { installPageShortcuts, type PageShortcutSettings } from "./page-shortcuts";

let settings: PageShortcutSettings = { enabled: true };

installPageShortcuts(document, chrome.runtime, () => settings);

void refreshSettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && changes[SETTINGS_KEY]) {
    void refreshSettings();
  }
});

/** This script runs on every supported page, so it reads its one setting without the Zod schema. */
async function refreshSettings(): Promise<void> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  // SAFETY: saveSettings in shared/settings.ts is the only writer of this key and always stores a
  // parsed GatherBoxSettings; both fields stay optional so a record from an older build reads too.
  const value = stored[SETTINGS_KEY] as StoredPageShortcutSetting | undefined;

  settings = { enabled: readPageShortcutsEnabled(value) };
}
