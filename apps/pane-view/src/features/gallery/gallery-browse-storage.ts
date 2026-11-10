import { GallerySortModeSchema } from "@latch-works/media-domain";
import { z } from "zod";
import { GalleryRandomSeedSchema } from "@/features/library/listing-contract";
import { parseJsonWith } from "@/lib/parse-json";

/**
 * Local persistence for the gallery browse state (Plan 048): `pane-view.state`
 * holds the browse snapshot below, and `pane-view.recursive-excludes` (Plan
 * 054) a record of browse path → excluded direct-child paths; excludes are
 * per-browser by design and never part of shareable URLs.
 */

const STATE_KEY = "pane-view.state";

const RECURSIVE_EXCLUDES_KEY = "pane-view.recursive-excludes";

const PersistedBrowseFieldsSchema = z.object({
  comicMode: z.boolean().catch(false),
  detailPanelOpen: z.boolean().catch(true),
  lastPath: z.string().catch(""),
  /** Null until a seed has been created; the hook fills it on first load. */
  randomSeed: GalleryRandomSeedSchema.nullable().catch(null),
  recursive: z.boolean().catch(false),
  sortMode: GallerySortModeSchema.catch("name-asc"),
});

/**
 * Tolerant parse of the stored snapshot: each malformed or missing field falls
 * back to its default independently, unknown keys are dropped, and a non-object
 * value yields the defaults outright.
 */
export const PersistedBrowseStateSchema = PersistedBrowseFieldsSchema.catch(() =>
  PersistedBrowseFieldsSchema.parse({}),
);

export type PersistedBrowseState = z.infer<typeof PersistedBrowseStateSchema>;

export const PERSISTED_BROWSE_STATE_DEFAULTS: PersistedBrowseState =
  PersistedBrowseFieldsSchema.parse({});

// SAFETY: a zod object's shape has exactly the parsed object's fields as keys.
const PERSISTED_BROWSE_STATE_FIELDS = Object.keys(PersistedBrowseFieldsSchema.shape) as Array<
  keyof PersistedBrowseState
>;

export function samePersistedBrowseState(
  left: PersistedBrowseState,
  right: PersistedBrowseState,
): boolean {
  return PERSISTED_BROWSE_STATE_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Browse path → excluded direct-child paths; a malformed record reads as
 * empty. Stored as a JSON object but held as a Map: browse paths are archive
 * folder names, and names such as `constructor` or `__proto__` must not
 * collide with Object.prototype members on lookup or parse.
 */
const RecursiveExcludesRecordSchema = z
  // z.custom passes the parsed JSON object through as is; z.record would copy
  // it by assignment and drop an own `__proto__` key on the way.
  .custom<object>((value) => z.looseObject({}).safeParse(value).success)
  .transform((record) => Object.entries(record))
  .pipe(z.array(z.tuple([z.string(), z.array(z.string()).catch([])])))
  .transform((entries) => new Map(entries))
  .catch(() => new Map());

type RecursiveExcludesRecord = z.infer<typeof RecursiveExcludesRecordSchema>;

/**
 * The record with `path`'s entry replaced by the deduped `paths`, or removed
 * when the list is empty so the record does not grow unboundedly.
 */
function withExcludedChildPaths(
  record: RecursiveExcludesRecord,
  path: string,
  paths: readonly string[],
): RecursiveExcludesRecord {
  const next = new Map(record);
  const deduped = [...new Set(paths)];

  if (deduped.length > 0) {
    next.set(path, deduped);
  } else {
    next.delete(path);
  }

  return next;
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
  value: PersistedBrowseState | Record<string, string[]>,
): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage errors (quota, private mode) must never break browsing.
  }
}

/**
 * The stored browse state; the defaults when nothing (readable) is stored, and
 * null outside a browser, which has no browse state to hydrate.
 */
export function readBrowseState(): PersistedBrowseState | null {
  if (!("window" in globalThis)) {
    return null;
  }

  const text = readStoredText(STATE_KEY);

  return text === null
    ? PERSISTED_BROWSE_STATE_DEFAULTS
    : (parseJsonWith(text, PersistedBrowseStateSchema) ?? PERSISTED_BROWSE_STATE_DEFAULTS);
}

export function writeBrowseState(state: PersistedBrowseState): void {
  writeStoredJson(STATE_KEY, state);
}

/** The stored exclude list for `path`; empty when nothing is stored or storage is unavailable. */
export function readExcludedChildPaths(path: string): string[] {
  return readExcludesRecord().get(path) ?? [];
}

/** Deduped write; an empty list deletes the path's entry so the record does not grow unboundedly. */
export function writeExcludedChildPaths(path: string, paths: readonly string[]): void {
  writeStoredJson(
    RECURSIVE_EXCLUDES_KEY,
    Object.fromEntries(withExcludedChildPaths(readExcludesRecord(), path, paths)),
  );
}

function readExcludesRecord(): RecursiveExcludesRecord {
  const text = readStoredText(RECURSIVE_EXCLUDES_KEY);

  return text === null
    ? new Map()
    : (parseJsonWith(text, RecursiveExcludesRecordSchema) ?? new Map());
}
