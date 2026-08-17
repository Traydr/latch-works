import { GallerySortModeSchema } from "@latch-works/media-domain";
import { z } from "zod";
import { GalleryRandomSeedSchema } from "@/features/gallery/gallery-random-seed";
import {
  type RootGalleryPreferences,
  RootGalleryPreferencesSchema,
} from "@/features/settings/types";
import { parseJsonWith } from "@/lib/parse-json";

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

/**
 * Tolerant parse of the stored snapshot: each malformed or missing field falls
 * back to its default independently, unknown keys are dropped, and a non-object
 * value yields the defaults outright.
 */
export const PersistedBrowseStateSchema = z
  .object({
    comicMode: z.boolean().catch(false),
    detailPanelOpen: z.boolean().catch(true),
    lastPath: z.string().catch(""),
    /** Null until a seed has been created; the hook fills it on first load. */
    randomSeed: GalleryRandomSeedSchema.nullable().catch(null),
    recursive: z.boolean().catch(false),
    sortMode: GallerySortModeSchema.catch("name-asc"),
  })
  .catch({
    comicMode: false,
    detailPanelOpen: true,
    lastPath: "",
    randomSeed: null,
    recursive: false,
    sortMode: "name-asc",
  });

export type PersistedBrowseState = z.infer<typeof PersistedBrowseStateSchema>;

export const PERSISTED_BROWSE_STATE_DEFAULTS: PersistedBrowseState =
  PersistedBrowseStateSchema.parse({});

const RootPreferencesRecordSchema = z.record(z.string(), RootGalleryPreferencesSchema).catch({});

export interface GalleryBrowseStorage {
  /** Null when nothing is stored or storage is unavailable (server render, quota, parse error). */
  read(): PersistedBrowseState | null;
  write(state: PersistedBrowseState): void;
  /** Mirror the resolved per-root flags. Nothing reads them back yet (see RootGalleryPreferences). */
  writeRootPreferences(rootKey: string, preferences: RootGalleryPreferences): void;
}

/** The first path segment; per-root preferences are keyed by it. */
export function resolveRootKey(path: string): string {
  return path ? (path.split("/")[0] ?? "") : "";
}

/** The stored text for `key`, or null when storage is unavailable or empty. */
function readStoredText(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStoredJson(
  key: string,
  value: PersistedBrowseState | Record<string, RootGalleryPreferences>,
): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage errors (quota, private mode) must never break browsing.
  }
}

export function createLocalStorageBrowseStorage(): GalleryBrowseStorage {
  return {
    read() {
      // The adapter is constructed at module load, which may be a server
      // render; only a browser window has browse state to hydrate.
      if (!("window" in globalThis)) {
        return null;
      }
      // Nothing stored (or unreadable) is still "hydrated": browse with defaults.
      const text = readStoredText(STATE_KEY);
      return text === null
        ? PERSISTED_BROWSE_STATE_DEFAULTS
        : (parseJsonWith(text, PersistedBrowseStateSchema) ?? PERSISTED_BROWSE_STATE_DEFAULTS);
    },
    write(state) {
      writeStoredJson(STATE_KEY, state);
    },
    writeRootPreferences(rootKey, preferences) {
      const text = readStoredText(ROOT_PREFS_KEY);
      const record = text === null ? {} : (parseJsonWith(text, RootPreferencesRecordSchema) ?? {});
      writeStoredJson(ROOT_PREFS_KEY, { ...record, [rootKey]: preferences });
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
