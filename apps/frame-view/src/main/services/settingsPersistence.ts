import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Rectangle } from 'electron';
import { z } from 'zod';

import {
  AppSettingsSchema,
  DebugSettingsSchema,
  GallerySortModeSchema,
  type JsonValue,
  LastFolderPathSchema,
  MediaExtensionsSchema,
  RandomSeedSchema,
  RootGalleryPreferencesMapSchema,
  ThemeModeSchema,
  ThumbnailSizeSchema,
} from '../../shared/contracts';
import { type AppSettings, DEFAULT_SETTINGS } from '../../shared/types';

const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const PERSISTED_STATE_VERSION = 3;

export interface PersistedStateV3 {
  version: 3;
  settings: AppSettings;
  windowBounds: Rectangle | null;
  windowMaximized: boolean;
}

function cloneDefaultSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    debug: {
      ...DEFAULT_SETTINGS.debug,
    },
    filters: {
      ...DEFAULT_SETTINGS.filters,
      imageExtensions: [...DEFAULT_SETTINGS.filters.imageExtensions],
      videoExtensions: [...DEFAULT_SETTINGS.filters.videoExtensions],
    },
    rootGalleryPreferences: {},
  };
}

/** A JSON object as read from the settings file, before any field is parsed. */
const PersistedRecordSchema = z.record(z.string(), z.json());
type PersistedRecord = z.infer<typeof PersistedRecordSchema>;

function toPersistedRecord(value: JsonValue): PersistedRecord {
  const parsed = PersistedRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function parseOrFallback<T>(schema: z.ZodType<T>, value: JsonValue, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function normalizeExtensions(input: JsonValue, fallback: string[]): string[] {
  const parsed = MediaExtensionsSchema.safeParse(input);
  if (!parsed.success || parsed.data.length === 0) {
    return [...fallback];
  }

  return parsed.data;
}

export function normalizeAppSettings(candidate: JsonValue): AppSettings {
  const parsed = AppSettingsSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  const raw = toPersistedRecord(candidate);
  const rawFilters = toPersistedRecord(raw.filters);
  const rawDebug = toPersistedRecord(raw.debug);

  const mergedCandidate = {
    ...DEFAULT_SETTINGS,
    ...raw,
    filters: {
      ...DEFAULT_SETTINGS.filters,
      ...rawFilters,
      imageExtensions: normalizeExtensions(
        rawFilters.imageExtensions,
        DEFAULT_SETTINGS.filters.imageExtensions,
      ),
      videoExtensions: normalizeExtensions(
        rawFilters.videoExtensions,
        DEFAULT_SETTINGS.filters.videoExtensions,
      ),
    },
    rootGalleryPreferences: parseOrFallback(
      RootGalleryPreferencesMapSchema,
      raw.rootGalleryPreferences,
      DEFAULT_SETTINGS.rootGalleryPreferences,
    ),
    debug: {
      ...DEFAULT_SETTINGS.debug,
      ...rawDebug,
    },
  };

  const reParsed = AppSettingsSchema.safeParse(mergedCandidate);
  if (reParsed.success) {
    return reParsed.data;
  }

  const imageExtensions = normalizeExtensions(
    rawFilters.imageExtensions,
    DEFAULT_SETTINGS.filters.imageExtensions,
  );
  if (!imageExtensions.includes('gif')) {
    imageExtensions.push('gif');
  }

  const videoExtensions = normalizeExtensions(
    rawFilters.videoExtensions,
    DEFAULT_SETTINGS.filters.videoExtensions,
  );

  return {
    ...DEFAULT_SETTINGS,
    theme: parseOrFallback(ThemeModeSchema, raw.theme, DEFAULT_SETTINGS.theme),
    rememberLastFolder: parseOrFallback(
      z.boolean(),
      raw.rememberLastFolder,
      DEFAULT_SETTINGS.rememberLastFolder,
    ),
    recursiveDefault: parseOrFallback(
      z.boolean(),
      raw.recursiveDefault,
      DEFAULT_SETTINGS.recursiveDefault,
    ),
    autoplayOnHover: parseOrFallback(
      z.boolean(),
      raw.autoplayOnHover,
      DEFAULT_SETTINGS.autoplayOnHover,
    ),
    autoplayVideos: parseOrFallback(
      z.boolean(),
      raw.autoplayVideos,
      DEFAULT_SETTINGS.autoplayVideos,
    ),
    loopViewerNavigation: parseOrFallback(
      z.boolean(),
      raw.loopViewerNavigation,
      DEFAULT_SETTINGS.loopViewerNavigation,
    ),
    previewAudioEnabled: parseOrFallback(
      z.boolean(),
      raw.previewAudioEnabled,
      DEFAULT_SETTINGS.previewAudioEnabled,
    ),
    loopVideos: parseOrFallback(z.boolean(), raw.loopVideos, DEFAULT_SETTINGS.loopVideos),
    thumbnailSize: parseOrFallback(
      ThumbnailSizeSchema,
      raw.thumbnailSize,
      DEFAULT_SETTINGS.thumbnailSize,
    ),
    sortMode: parseOrFallback(GallerySortModeSchema, raw.sortMode, DEFAULT_SETTINGS.sortMode),
    randomSeed: parseOrFallback(RandomSeedSchema, raw.randomSeed, DEFAULT_SETTINGS.randomSeed),
    filters: {
      ...DEFAULT_SETTINGS.filters,
      imageExtensions,
      videoExtensions,
      showImages: parseOrFallback(
        z.boolean(),
        rawFilters.showImages,
        DEFAULT_SETTINGS.filters.showImages,
      ),
      showVideos: parseOrFallback(
        z.boolean(),
        rawFilters.showVideos,
        DEFAULT_SETTINGS.filters.showVideos,
      ),
    },
    rootGalleryPreferences: parseOrFallback(
      RootGalleryPreferencesMapSchema,
      raw.rootGalleryPreferences,
      DEFAULT_SETTINGS.rootGalleryPreferences,
    ),
    lastFolderPath: parseOrFallback(
      LastFolderPathSchema,
      raw.lastFolderPath,
      DEFAULT_SETTINGS.lastFolderPath,
    ),
    debug: parseOrFallback(DebugSettingsSchema, rawDebug, DEFAULT_SETTINGS.debug),
  };
}

function normalizeWindowBounds(bounds: JsonValue): Rectangle | null {
  const parsed = WindowBoundsSchema.safeParse(bounds);
  if (!parsed.success) {
    return null;
  }

  return {
    x: Math.round(parsed.data.x),
    y: Math.round(parsed.data.y),
    width: Math.max(980, Math.round(parsed.data.width)),
    height: Math.max(640, Math.round(parsed.data.height)),
  };
}

export function createDefaultPersistedState(): PersistedStateV3 {
  return {
    version: PERSISTED_STATE_VERSION,
    settings: cloneDefaultSettings(),
    windowBounds: null,
    windowMaximized: false,
  };
}

function addAvifToImageExtensions(settings: AppSettings): AppSettings {
  if (settings.filters.imageExtensions.includes('avif')) {
    return settings;
  }

  return {
    ...settings,
    filters: {
      ...settings.filters,
      imageExtensions: [...settings.filters.imageExtensions, 'avif'],
    },
  };
}

function migratePersistedState(candidate: JsonValue): PersistedStateV3 {
  const raw = toPersistedRecord(candidate);
  const settings = normalizeAppSettings(raw.settings);

  return {
    version: PERSISTED_STATE_VERSION,
    settings:
      raw.version === PERSISTED_STATE_VERSION ? settings : addAvifToImageExtensions(settings),
    windowBounds: normalizeWindowBounds(raw.windowBounds),
    windowMaximized: raw.windowMaximized === true || raw.windowFullscreen === true,
  };
}

export async function readPersistedState(filePath: string): Promise<PersistedStateV3> {
  const raw = await fs.readFile(filePath, 'utf8');
  return migratePersistedState(JSON.parse(raw));
}

export async function writePersistedState(
  filePath: string,
  state: PersistedStateV3,
): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  const tempFilePath = `${filePath}.tmp`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tempFilePath, payload, 'utf8');
  await fs.rename(tempFilePath, filePath);
}
