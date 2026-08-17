/**
 * The gallery random seed: 32 lowercase hexadecimal characters (16 random
 * bytes). It travels on every listing request and inside every cursor, and the
 * server derives one total order from it. Kept free of Node imports so both the
 * client and the server can share the type and the validator.
 */
export type GalleryRandomSeed = string;

export const GALLERY_RANDOM_SEED_PATTERN = /^[0-9a-f]{32}$/u;

export function isGalleryRandomSeed(value: unknown): value is GalleryRandomSeed {
  return typeof value === "string" && GALLERY_RANDOM_SEED_PATTERN.test(value);
}

export type RandomBytesSource = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandomBytes: RandomBytesSource = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

/**
 * Create a fresh seed. Never returns `previous`, so Shuffle always changes the
 * permutation even in the astronomically unlikely collision case.
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
