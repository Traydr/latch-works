import { GatherBoxSettingsSchema, SETTINGS_KEY } from "../shared/settings";
import { installPageShortcuts, type PageShortcutSettings } from "./page-shortcuts";

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
  settings = { enabled: GatherBoxSettingsSchema.parse(stored[SETTINGS_KEY]).pageShortcutsEnabled };
}
