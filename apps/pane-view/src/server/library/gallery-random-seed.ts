/**
 * The gallery random seed contract: 32 lowercase hexadecimal characters (16
 * random bytes). It travels on every listing request and inside every cursor,
 * and the server derives one total order from it. Environment-neutral (no
 * Node or DOM imports) so the server ordering module and the client can share
 * the type and the validator; the client creates seeds in
 * features/gallery/gallery-random-seed.ts.
 */
export type GalleryRandomSeed = string;

export const GALLERY_RANDOM_SEED_PATTERN = /^[0-9a-f]{32}$/u;

export function isGalleryRandomSeed(value: unknown): value is GalleryRandomSeed {
  return typeof value === "string" && GALLERY_RANDOM_SEED_PATTERN.test(value);
}
