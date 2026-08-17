import { z } from "zod";

/**
 * The gallery random seed contract: 32 lowercase hexadecimal characters (16
 * random bytes). It travels on every listing request and inside every cursor,
 * and the server derives one total order from it. Environment-neutral (no
 * Node or DOM imports) so the server ordering module and the client can share
 * the schema; the client creates seeds in features/gallery/gallery-random-seed.ts.
 */
export const GALLERY_RANDOM_SEED_PATTERN = /^[0-9a-f]{32}$/u;

export const GalleryRandomSeedSchema = z.string().regex(GALLERY_RANDOM_SEED_PATTERN);

export type GalleryRandomSeed = z.infer<typeof GalleryRandomSeedSchema>;
