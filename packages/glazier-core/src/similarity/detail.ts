import type { SharpLibrary } from "../media/toolkit.js";
import { greyPixels } from "./fingerprint.js";

/**
 * A detail print is a still as 64×64 grey: twice the fingerprint's side, so a changed face, an
 * outfit or a caption in another language still shows, where the 64-bit fingerprint calls the
 * pictures the same.
 */
const DETAIL_SIZE = 64;

/** Bumped when prints are made differently; older ones are made again. */
export const DETAIL_VERSION = 1;

/** Prints are compared in 4×4 blocks, a 16×16 grid. */
const BLOCK = 4;

const GRID = DETAIL_SIZE / BLOCK;

/** Each print is scaled to zero mean and this spread, so a re-encode's shifted tones cancel out. */
const SPREAD = 48;

/**
 * How far the most changed block may stand above the typical one for two prints to still show
 * one picture. Measured on the owner's decisions: copies they removed stood under 4 in 95 of 100
 * pairs, and versions they kept together stood above it in 98 of 100.
 */
const VARIANT_LOCAL = 4;

/**
 * Two lossless files that match everywhere but one spot (closed eyes, a moved signature) have a
 * typical block difference of nothing, so a smaller standout already means a change.
 */
const LOSSLESS_TYPICAL = 0.05;

const LOSSLESS_LOCAL = 1;

/**
 * Stills are decoded at four times the print's side and averaged down. Resized straight to 64,
 * a JPEG decoded at an eighth and its resized copy alias differently, and on the owner's copies
 * the print then called three in five of them variants.
 */
const AVERAGED = 4;

export async function detailOfStill(sharp: SharpLibrary, filePath: string): Promise<Uint8Array> {
  const decoded = DETAIL_SIZE * AVERAGED;
  const pixels = await greyPixels(sharp, filePath, { size: decoded });
  const print = new Uint8Array(DETAIL_SIZE * DETAIL_SIZE);

  for (let row = 0; row < DETAIL_SIZE; row += 1) {
    for (let column = 0; column < DETAIL_SIZE; column += 1) {
      let sum = 0;

      for (let y = 0; y < AVERAGED; y += 1) {
        const start = (row * AVERAGED + y) * decoded + column * AVERAGED;

        for (let x = 0; x < AVERAGED; x += 1) {
          sum += pixels[start + x] ?? 0;
        }
      }

      print[row * DETAIL_SIZE + column] = Math.round(sum / (AVERAGED * AVERAGED));
    }
  }

  return print;
}

/** A print scaled for comparing; make it once per print, not once per pair. */
export function normalizeDetail(print: Uint8Array): Float32Array {
  let mean = 0;

  for (const value of print) {
    mean += value;
  }

  mean /= print.length;

  let variance = 0;

  for (const value of print) {
    variance += (value - mean) ** 2;
  }

  const deviation = Math.sqrt(variance / print.length) || 1;

  return Float32Array.from(print, (value) => ((value - mean) / deviation) * SPREAD);
}

/** How two prints differ: the typical block, and how far the most changed one stands above it. */
interface DetailDifference {
  typical: number;
  local: number;
}

function detailDifference(left: Float32Array, right: Float32Array): DetailDifference {
  const blocks = new Float32Array(GRID * GRID);

  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      let sum = 0;

      for (let y = 0; y < BLOCK; y += 1) {
        const start = (row * BLOCK + y) * DETAIL_SIZE + column * BLOCK;

        for (let x = 0; x < BLOCK; x += 1) {
          sum += Math.abs((left[start + x] ?? 0) - (right[start + x] ?? 0));
        }
      }

      blocks[row * GRID + column] = sum / (BLOCK * BLOCK);
    }
  }

  blocks.sort();

  const typical = blocks[blocks.length / 2] ?? 0;

  return { typical, local: (blocks[blocks.length - 1] ?? 0) - typical };
}

/**
 * Whether two similar stills are variants, different pictures that share most of their pixels
 * (another face or outfit, a caption's language), rather than copies of one picture, which
 * differ a little everywhere when one was resized or recompressed.
 */
export function isVariant(left: Float32Array, right: Float32Array): boolean {
  const { typical, local } = detailDifference(left, right);

  return local > VARIANT_LOCAL || (typical <= LOSSLESS_TYPICAL && local > LOSSLESS_LOCAL);
}
