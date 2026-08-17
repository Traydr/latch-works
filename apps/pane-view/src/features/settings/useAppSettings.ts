import { useCallback, useEffect, useState } from "react";
import { parseJsonWith } from "@/lib/parse-json";
import {
  type AppSettings,
  type AppSettingsPatch,
  AppSettingsSchema,
  DEFAULT_APP_SETTINGS,
} from "./types";

const SETTINGS_KEY = "pane-view.settings";

function readSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw
      ? (parseJsonWith(raw, AppSettingsSchema) ?? DEFAULT_APP_SETTINGS)
      : DEFAULT_APP_SETTINGS;
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
