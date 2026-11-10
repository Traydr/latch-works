import type { GallerySortMode } from "@latch-works/media-domain";
import { GallerySortModeSchema } from "@latch-works/media-domain";
import { z } from "zod";
import {
  GalleryRandomOrderKeySchema,
  type GalleryRandomSeed,
  GalleryRandomSeedSchema,
  type GallerySubjectKind,
} from "@/features/library/listing-contract";
import { parseJsonWith } from "@/lib/parse-json";

/*
 * The listing cursor: an opaque base64url JSON token naming the last row a
 * page returned, in the order it was sorted by.
 */

/** The request facts a cursor must match to be honoured. */
export interface GalleryListingCursorRequest {
  randomSeed: GalleryRandomSeed;
  sortMode: GallerySortMode;
  subjectKind: GallerySubjectKind;
}

const cursorBaseSchema = z.object({
  sortMode: GallerySortModeSchema,
  randomSeed: GalleryRandomSeedSchema,
  /** Present in random mode: the last row's shared random-order key. */
  randomKey: GalleryRandomOrderKeySchema.optional(),
  /** A comic's newest or oldest page mtime, whichever the sort mode orders by. */
  mtimeMs: z.number(),
});

/** Cursor payload schema; unknown keys are dropped so stale cursors stay tolerant. */
const GalleryListingCursorPayloadSchema = z.discriminatedUnion("subjectKind", [
  cursorBaseSchema.extend({
    subjectKind: z.literal("media"),
    filename: z.string(),
    id: z.string(),
    logicalPath: z.string(),
  }),
  cursorBaseSchema.extend({
    subjectKind: z.literal("comic"),
    folderPath: z.string(),
  }),
]);

export type GalleryListingCursorPayload = z.infer<typeof GalleryListingCursorPayloadSchema>;

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

  const parsed = parseJsonWith(
    Buffer.from(encoded, "base64url").toString("utf8"),
    GalleryListingCursorPayloadSchema,
  );

  if (!parsed) {
    return null;
  }

  if (
    parsed.subjectKind !== request.subjectKind ||
    parsed.sortMode !== request.sortMode ||
    parsed.randomSeed !== request.randomSeed
  ) {
    return null;
  }

  // Random mode continues from the last row's rank; anything else is not a
  // continuation and must not be treated as one (a missing key would restart
  // at page 1 while still hiding the first page's folder cards).
  if (
    request.sortMode === "random" ? parsed.randomKey === undefined : parsed.randomKey !== undefined
  ) {
    return null;
  }

  return parsed;
}
