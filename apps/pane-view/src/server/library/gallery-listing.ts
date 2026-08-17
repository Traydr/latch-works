import type { BrowserEntry, GallerySortMode } from "@latch-works/media-domain";
import {
  type GalleryRandomSeed,
  type GallerySubjectKind,
  isGalleryRandomOrderKey,
} from "./gallery-order";
import type { LibraryMediaItem } from "./types";

export const DEFAULT_GALLERY_LISTING_LIMIT = 60;

/**
 * One comic as listed in the gallery: identity, display name, cover, and the
 * eligible page count under the current filters. Full pages load only when
 * the reader opens (getGalleryComic), so a listing page's size does not
 * depend on how many pages its comics have.
 */
export interface GalleryComicSummary {
  cover: LibraryMediaItem;
  folderPath: string;
  /** Equal to `folderPath`; the canonical comic identity. */
  id: string;
  name: string;
  pageCount: number;
}

/**
 * One page of the gallery listing, in final display order. The server owns
 * presentation order; clients append pages and never sort them.
 */
export interface GalleryListingPage {
  subjectKind: GallerySubjectKind;
  /** Media mode: folder + media entries as today. Comic mode: empty. */
  entries: BrowserEntry[];
  /** Media mode: the page's media. Comic mode: the covers, in listing order. */
  media: LibraryMediaItem[];
  /** Comic mode: the summaries, in listing order. Media mode: empty. */
  comics: GalleryComicSummary[];
  page: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
  };
}

/** The request facts a cursor must match to be honoured. */
export interface GalleryListingCursorRequest {
  randomSeed: GalleryRandomSeed;
  sortMode: GallerySortMode;
  subjectKind: GallerySubjectKind;
}

export type GalleryListingCursorPayload =
  | {
      subjectKind: "media";
      sortMode: GallerySortMode;
      randomSeed: GalleryRandomSeed;
      /** Present in random mode: the last row's shared random-order key. */
      randomKey?: string;
      filename: string;
      id: string;
      logicalPath: string;
      mtimeMs: number;
    }
  | {
      subjectKind: "comic";
      sortMode: GallerySortMode;
      randomSeed: GalleryRandomSeed;
      randomKey?: string;
      folderPath: string;
      /** The comic's newest or oldest page mtime, whichever the sort mode orders by. */
      mtimeMs: number;
    };

/** The random-mode rank a decoded cursor carries; decode guarantees it is present. */
export function cursorRandomKey(cursor: GalleryListingCursorPayload): string {
  if (!cursor.randomKey) {
    throw new Error("Random-mode gallery cursor without a rank");
  }
  return cursor.randomKey;
}

export function encodeGalleryListingCursor(payload: GalleryListingCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a cursor for `request`. Returns null — meaning "start from page 1" —
 * when the cursor is malformed or was issued for a different subject kind,
 * sort mode, or seed, so a stale cursor can never splice one order into
 * another.
 */
export function decodeGalleryListingCursor(
  encoded: string | undefined,
  request: GalleryListingCursorRequest,
): GalleryListingCursorPayload | null {
  if (!encoded) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (
    record.subjectKind !== request.subjectKind ||
    record.sortMode !== request.sortMode ||
    record.randomSeed !== request.randomSeed ||
    typeof record.mtimeMs !== "number"
  ) {
    return null;
  }
  // Random mode continues from the last row's rank; anything else is not a
  // continuation and must not be treated as one (a missing key would restart
  // at page 1 while still hiding the first page's folder cards).
  if (
    request.sortMode === "random"
      ? !isGalleryRandomOrderKey(record.randomKey)
      : record.randomKey !== undefined
  ) {
    return null;
  }

  if (record.subjectKind === "media") {
    if (
      typeof record.filename !== "string" ||
      typeof record.id !== "string" ||
      typeof record.logicalPath !== "string"
    ) {
      return null;
    }

    return {
      filename: record.filename,
      id: record.id,
      logicalPath: record.logicalPath,
      mtimeMs: record.mtimeMs,
      randomKey: record.randomKey as string | undefined,
      randomSeed: request.randomSeed,
      sortMode: request.sortMode,
      subjectKind: "media",
    };
  }

  if (typeof record.folderPath !== "string") {
    return null;
  }

  return {
    folderPath: record.folderPath,
    mtimeMs: record.mtimeMs,
    randomKey: record.randomKey as string | undefined,
    randomSeed: request.randomSeed,
    sortMode: request.sortMode,
    subjectKind: "comic",
  };
}
