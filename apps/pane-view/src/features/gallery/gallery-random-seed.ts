import type { GalleryRandomSeed } from "@/features/library/listing-contract";

/**
 * Create a fresh seed from 16 random bytes. Never returns `previous`, so
 * Shuffle always changes the permutation even in the astronomically unlikely
 * collision case.
 */
export function createGalleryRandomSeed(previous?: GalleryRandomSeed | null): GalleryRandomSeed {
  const bytes = new Uint8Array(new ArrayBuffer(16));

  for (;;) {
    globalThis.crypto.getRandomValues(bytes);
    const seed = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

    if (seed !== previous) {
      return seed;
    }
  }
}
