import type { AppSettings, AppSettingsPatch, RootGalleryPreferences } from '../../shared/types';

const DEFAULT_ROOT_GALLERY_PREFERENCES: RootGalleryPreferences = {
  comicMode: false,
  excludedRootChildPaths: [],
};

export function getRootGalleryPreferences(
  settings: AppSettings,
  rootPath: string | null,
): RootGalleryPreferences {
  if (!rootPath) {
    return DEFAULT_ROOT_GALLERY_PREFERENCES;
  }

  return settings.rootGalleryPreferences[rootPath] ?? DEFAULT_ROOT_GALLERY_PREFERENCES;
}

export function createRootGalleryPreferencesPatch(
  settings: AppSettings,
  rootPath: string,
  preferences: RootGalleryPreferences,
): AppSettingsPatch {
  return {
    rootGalleryPreferences: {
      ...settings.rootGalleryPreferences,
      [rootPath]: {
        comicMode: preferences.comicMode,
        excludedRootChildPaths: Array.from(new Set(preferences.excludedRootChildPaths)),
      },
    },
  };
}

export function toggleExcludedRootChildPath(
  preferences: RootGalleryPreferences,
  folderPath: string,
): RootGalleryPreferences {
  const excluded = new Set(preferences.excludedRootChildPaths);
  if (excluded.has(folderPath)) {
    excluded.delete(folderPath);
  } else {
    excluded.add(folderPath);
  }

  return {
    ...preferences,
    excludedRootChildPaths: Array.from(excluded),
  };
}
