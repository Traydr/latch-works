/** The pHash reads a 32×32 greyscale thumbnail and keeps its lowest 8×8 DCT frequencies. */
export const PHASH_INPUT_SIZE = 32;

const HASH_SIZE = 8;

/** cos((2x + 1)uπ / 64) for u < 8, x < 32, row-major by u. */
const COSINES = (() => {
  const table = new Float64Array(HASH_SIZE * PHASH_INPUT_SIZE);

  for (let u = 0; u < HASH_SIZE; u += 1) {
    for (let x = 0; x < PHASH_INPUT_SIZE; x += 1) {
      table[u * PHASH_INPUT_SIZE + x] = Math.cos(
        ((2 * x + 1) * u * Math.PI) / (2 * PHASH_INPUT_SIZE),
      );
    }
  }

  return table;
})();

/** A 64-bit perceptual hash as two unsigned 32-bit halves, the form the matcher compares. */
export interface Hash64 {
  hi: number;
  lo: number;
}

/**
 * The perceptual hash of a 32×32 8-bit greyscale image (1024 bytes, row-major): each of the 64
 * low-frequency DCT coefficients becomes a bit set when it exceeds their median. Resizing,
 * recompression and format changes move few bits; different pictures differ in about half.
 */
export function perceptualHash(pixels: Uint8Array): Hash64 {
  if (pixels.length !== PHASH_INPUT_SIZE * PHASH_INPUT_SIZE) {
    throw new Error(`A pHash needs ${PHASH_INPUT_SIZE}×${PHASH_INPUT_SIZE} grey pixels.`);
  }

  // Rows first: rowSums[y][u] = Σx pixel(x, y)·cos_u(x).
  const rowSums = new Float64Array(PHASH_INPUT_SIZE * HASH_SIZE);

  for (let y = 0; y < PHASH_INPUT_SIZE; y += 1) {
    for (let u = 0; u < HASH_SIZE; u += 1) {
      let sum = 0;

      for (let x = 0; x < PHASH_INPUT_SIZE; x += 1) {
        sum += (pixels[y * PHASH_INPUT_SIZE + x] ?? 0) * (COSINES[u * PHASH_INPUT_SIZE + x] ?? 0);
      }

      rowSums[y * HASH_SIZE + u] = sum;
    }
  }

  const coefficients = new Float64Array(HASH_SIZE * HASH_SIZE);

  for (let v = 0; v < HASH_SIZE; v += 1) {
    for (let u = 0; u < HASH_SIZE; u += 1) {
      let sum = 0;

      for (let y = 0; y < PHASH_INPUT_SIZE; y += 1) {
        sum += (rowSums[y * HASH_SIZE + u] ?? 0) * (COSINES[v * PHASH_INPUT_SIZE + y] ?? 0);
      }

      coefficients[v * HASH_SIZE + u] = sum;
    }
  }

  // The DC term (overall brightness) would dominate the median, so it is left out of it.
  const median = medianOf(coefficients.subarray(1));
  let hi = 0;
  let lo = 0;

  for (let index = 0; index < 64; index += 1) {
    if ((coefficients[index] ?? 0) > median) {
      if (index < 32) {
        hi |= 1 << (31 - index);
      } else {
        lo |= 1 << (63 - index);
      }
    }
  }

  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function medianOf(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Bits set in a 32-bit integer. */
function popcount32(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);

  return Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

export function hammingDistance(left: Hash64, right: Hash64): number {
  return popcount32(left.hi ^ right.hi) + popcount32(left.lo ^ right.lo);
}

export function formatHash(hash: Hash64): string {
  return hash.hi.toString(16).padStart(8, "0") + hash.lo.toString(16).padStart(8, "0");
}

export function parseHash(hex: string): Hash64 {
  if (!/^[0-9a-f]{16}$/.test(hex)) {
    throw new Error(`Not a 64-bit hash: ${hex}`);
  }

  return { hi: Number.parseInt(hex.slice(0, 8), 16), lo: Number.parseInt(hex.slice(8), 16) };
}
