import { useCallback, useEffect, useState } from "react";
import { type AppSettings, type AppSettingsPatch, DEFAULT_APP_SETTINGS } from "./types";

const SETTINGS_KEY = "pane-view.settings";

function readSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_APP_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_APP_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

function writeSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors.
  }
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setSettings(readSettings());
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (isReady) {
      writeSettings(settings);
    }
  }, [isReady, settings]);

  const updateSettings = useCallback((patch: AppSettingsPatch) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  return { settings, updateSettings };
}
