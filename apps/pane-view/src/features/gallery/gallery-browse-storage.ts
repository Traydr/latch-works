import type { GallerySortMode } from "@latch-works/media-domain";
import { GallerySortModeSchema } from "@latch-works/media-domain";
import {
  type GalleryRandomSeed,
  isGalleryRandomSeed,
} from "@/features/gallery/gallery-random-seed";
import type { RootGalleryPreferences } from "@/features/settings/types";

/**
 * Local persistence for the gallery browse state (Plan 048). Two localStorage
 * keys survive from before the refactor so existing browsers keep their
 * preferences: `pane-view.state` (the browse snapshot below, minus the retired
 * `lastSelectedId`) and `pane-view.root-preferences` (per-root flags, written
 * only — see RootGalleryPreferences). Everything reads and writes through the
 * GalleryBrowseStorage adapter so the hook can be tested without a DOM.
 */

const STATE_KEY = "pane-view.state";
const ROOT_PREFS_KEY = "pane-view.root-preferences";

export interface PersistedBrowseState {
  comicMode: boolean;
  detailPanelOpen: boolean;
  lastPath: string;
  /** Null until a seed has been created; the hook fills it on first load. */
  randomSeed: GalleryRandomSeed | null;
  recursive: boolean;
  sortMode: GallerySortMode;
}

export const PERSISTED_BROWSE_STATE_DEFAULTS: PersistedBrowseState = {
  comicMode: false,
  detailPanelOpen: true,
  lastPath: "",
  randomSeed: null,
  recursive: false,
  sortMode: "name-asc",
};

export interface GalleryBrowseStorage {
  /** Null when nothing is stored or storage is unavailable (server render, quota, parse error). */
  read(): PersistedBrowseState | null;
  write(state: PersistedBrowseState): void;
  /** Mirror the resolved per-root flags. Nothing reads them back yet (see RootGalleryPreferences). */
  writeRootPreferences(rootKey: string, preferences: RootGalleryPreferences): void;
}

/** Tolerant parse: unknown or malformed fields fall back to the defaults, extra keys are ignored. */
export function parsePersistedBrowseState(raw: unknown): PersistedBrowseState {
  if (typeof raw !== "object" || raw === null) {
    return PERSISTED_BROWSE_STATE_DEFAULTS;
  }
  const record = raw as Record<string, unknown>;
  const sortMode = GallerySortModeSchema.safeParse(record.sortMode);
  return {
    comicMode:
      typeof record.comicMode === "boolean"
        ? record.comicMode
        : PERSISTED_BROWSE_STATE_DEFAULTS.comicMode,
    detailPanelOpen:
      typeof record.detailPanelOpen === "boolean"
        ? record.detailPanelOpen
        : PERSISTED_BROWSE_STATE_DEFAULTS.detailPanelOpen,
    lastPath:
      typeof record.lastPath === "string"
        ? record.lastPath
        : PERSISTED_BROWSE_STATE_DEFAULTS.lastPath,
    randomSeed: isGalleryRandomSeed(record.randomSeed) ? record.randomSeed : null,
    recursive:
      typeof record.recursive === "boolean"
        ? record.recursive
        : PERSISTED_BROWSE_STATE_DEFAULTS.recursive,
    sortMode: sortMode.success ? sortMode.data : PERSISTED_BROWSE_STATE_DEFAULTS.sortMode,
  };
}

/** The first path segment; per-root preferences are keyed by it. */
export function resolveRootKey(path: string): string {
  return path ? (path.split("/")[0] ?? "") : "";
}

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage errors (quota, private mode) must never break browsing.
  }
}

export function createLocalStorageBrowseStorage(): GalleryBrowseStorage {
  return {
    read() {
      if (typeof window === "undefined") {
        return null;
      }
      // Nothing stored (or unreadable) is still "hydrated": browse with defaults.
      return parsePersistedBrowseState(readJson(STATE_KEY) ?? {});
    },
    write(state) {
      writeJson(STATE_KEY, state);
    },
    writeRootPreferences(rootKey, preferences) {
      const all = readJson(ROOT_PREFS_KEY);
      const record =
        typeof all === "object" && all !== null
          ? (all as Record<string, RootGalleryPreferences>)
          : {};
      writeJson(ROOT_PREFS_KEY, { ...record, [rootKey]: preferences });
    },
  };
}

export interface MemoryBrowseStorage extends GalleryBrowseStorage {
  rootPreferences: Record<string, RootGalleryPreferences>;
  state: PersistedBrowseState | null;
  writes: number;
}

/** In-memory adapter for tests. `null` simulates unavailable storage (server render). */
export function createMemoryBrowseStorage(
  initial: Partial<PersistedBrowseState> | null = {},
): MemoryBrowseStorage {
  const storage: MemoryBrowseStorage = {
    read() {
      return storage.state;
    },
    rootPreferences: {},
    state: initial === null ? null : { ...PERSISTED_BROWSE_STATE_DEFAULTS, ...initial },
    write(state) {
      storage.state = { ...state };
      storage.writes += 1;
    },
    writeRootPreferences(rootKey, preferences) {
      storage.rootPreferences[rootKey] = { ...preferences };
    },
    writes: 0,
  };
  return storage;
}
