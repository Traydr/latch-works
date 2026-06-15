import { useCallback, useEffect, useState } from "react";
import {
  type AppSettings,
  type AppSettingsPatch,
  DEFAULT_APP_SETTINGS,
  type RootGalleryPreferences,
} from "./types";

const SETTINGS_KEY = "pane-view.settings";
const ROOT_PREFS_KEY = "pane-view.root-preferences";

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

function readRootPreferences(): Record<string, RootGalleryPreferences> {
  try {
    const raw = window.localStorage.getItem(ROOT_PREFS_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw) as Record<string, RootGalleryPreferences>;
  } catch {
    return {};
  }
}

function writeRootPreferences(preferences: Record<string, RootGalleryPreferences>): void {
  try {
    window.localStorage.setItem(ROOT_PREFS_KEY, JSON.stringify(preferences));
  } catch {
    // Ignore storage errors.
  }
}

export function resolveRootKey(currentPath: string): string {
  if (!currentPath) {
    return "";
  }

  return currentPath.split("/")[0] ?? "";
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);

  useEffect(() => {
    setSettings(readSettings());
  }, []);

  const updateSettings = useCallback((patch: AppSettingsPatch) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  return { settings, updateSettings };
}

export function useRootPreferences(rootKey: string) {
  const [preferences, setPreferences] = useState<RootGalleryPreferences | null>(null);

  useEffect(() => {
    const all = readRootPreferences();
    setPreferences(all[rootKey] ?? null);
  }, [rootKey]);

  const savePreferences = useCallback(
    (patch: Partial<RootGalleryPreferences>) => {
      const all = readRootPreferences();
      const current = all[rootKey] ?? {
        comicMode: false,
        recursive: false,
        sortMode: "name-asc" as const,
      };
      const next = { ...current, ...patch };
      all[rootKey] = next;
      writeRootPreferences(all);
      setPreferences(next);
    },
    [rootKey],
  );

  return { preferences, savePreferences };
}
