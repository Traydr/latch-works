import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { GalleryRandomSeed } from "./gallery-random-seed";

export {
  GALLERY_RANDOM_SEED_PATTERN,
  type GalleryRandomSeed,
  isGalleryRandomSeed,
} from "./gallery-random-seed";

/**
 * `expression COLLATE "natural"` — migration 0018's ICU natural,
 * case-insensitive order (Plan 051, Decision 6). Every name-ordered gallery
 * expression, media or comic, goes through this.
 */
export function naturalOrder(expression: SQL | AnyPgColumn): SQL {
  return sql`${expression} COLLATE "natural"`;
}

/**
 * What one gallery listing row stands for. A regular browse subject is one
 * media item (keyed by entry id); a comic browse subject is one comic (keyed by
 * its canonical folder path). The kind is part of the random key so the two
 * populations never share rank inputs by accident.
 */
export type GallerySubjectKind = "media" | "comic";

/**
 * The one random-order key. For a fixed seed every subject gets one
 * deterministic 32-hex rank; sorting by that rank is the full permutation that
 * every page slices. `galleryRandomOrderKey` and `galleryRandomOrderKeySql`
 * must agree byte for byte — gallery-order.test.ts and the pglite suite prove
 * it. Fixed-width lowercase hex keeps SQL text order and JS string order equal.
 * This is an ordering key, not a secret.
 */
export function galleryRandomOrderKey(
  seed: GalleryRandomSeed,
  subjectKind: GallerySubjectKind,
  subjectId: string,
): string {
  return createHash("md5").update(`${seed}:${subjectKind}:${subjectId}`).digest("hex");
}

export function galleryRandomOrderKeySql(
  seed: GalleryRandomSeed,
  subjectKind: GallerySubjectKind,
  subjectId: SQL | AnyPgColumn,
): SQL {
  return sql`md5(concat(${seed}::text, ':', ${subjectKind}::text, ':', ${subjectId}::text))`;
}

export const GALLERY_RANDOM_ORDER_KEY_PATTERN = /^[0-9a-f]{32}$/u;

/** The rank a random-mode cursor carries; validated by decodeGalleryListingCursor. */
export function isGalleryRandomOrderKey(value: unknown): value is string {
  return typeof value === "string" && GALLERY_RANDOM_ORDER_KEY_PATTERN.test(value);
}
