import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { GalleryRandomSeed, GallerySubjectKind } from "@/features/library/listing-contract";

/**
 * `expression COLLATE "natural"` — migration 0018's ICU natural,
 * case-insensitive order (Plan 051, Decision 6). Every name-ordered gallery
 * expression, media or comic, goes through this.
 */
export function naturalOrder(expression: SQL | AnyPgColumn): SQL {
  return sql`${expression} COLLATE "natural"`;
}

/**
 * The one random-order key. For a fixed seed every subject gets one
 * deterministic 32-hex rank; sorting by that rank is the full permutation that
 * every page slices; the subject kind is part of the input so the media and
 * comic populations never share ranks. `galleryRandomOrderKey` and `galleryRandomOrderKeySql`
 * must agree byte for byte: both are the md5 hex of the same
 * `seed:kind:id` text, and keyset-order.test.ts checks them against each
 * other under pglite. Fixed-width lowercase hex keeps SQL text order and JS
 * string order equal.
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
