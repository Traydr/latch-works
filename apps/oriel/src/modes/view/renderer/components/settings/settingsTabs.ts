export const SETTINGS_TABS = ['Usability', 'Local Storage', 'Hotkeys', 'Debug'] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
