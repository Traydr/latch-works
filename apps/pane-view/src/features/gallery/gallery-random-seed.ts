import type { GalleryRandomSeed } from "../../server/library/gallery-random-seed";

export {
  GALLERY_RANDOM_SEED_PATTERN,
  type GalleryRandomSeed,
  isGalleryRandomSeed,
} from "../../server/library/gallery-random-seed";

export type RandomBytesSource = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandomBytes: RandomBytesSource = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

/**
 * Create a fresh seed from 16 random bytes. Never returns `previous`, so
 * Shuffle always changes the permutation even in the astronomically unlikely
 * collision case.
 */
export function createGalleryRandomSeed(
  previous?: GalleryRandomSeed | null,
  randomBytes: RandomBytesSource = defaultRandomBytes,
): GalleryRandomSeed {
  const bytes = new Uint8Array(new ArrayBuffer(16));
  for (;;) {
    randomBytes(bytes);
    const seed = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (seed !== previous) {
      return seed;
    }
  }
}
