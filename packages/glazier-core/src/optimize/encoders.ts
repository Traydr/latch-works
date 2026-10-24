import { stat, writeFile } from "node:fs/promises";

import {
  ARCHIVE_AVIF_SHARP_OPTIONS,
  ARCHIVE_AVIF_WASM_PIXEL_LIMIT,
  type RgbaImage,
} from "@latch-works/media-format";
import type { StillEncodeRequest, StillEncodeResult, TranscodeJob } from "../contract.js";
import type { SharpLibrary } from "../media/toolkit.js";

export type { StillEncodeRequest, StillEncodeResult, TranscodeJob } from "../contract.js";

export {
  AnimatedImageMimeTypeSchema,
  AudioTrackPlanSchema,
  StillEncodeRequestSchema,
  StillEncodeResultSchema,
  TranscodeJobSchema,
  VideoTrackPlanSchema,
} from "../contract.js";

/** Runs a transcode job to completion; rejects with the transcoder's message when it fails. */
export interface Transcoder {
  transcode(
    job: TranscodeJob,
    signal: AbortSignal,
    onProgress: (ratio: number) => void,
  ): Promise<TranscodeOutcome>;
}

/** Which converter produced the file, and anything the journal should say about it. */
export interface TranscodeOutcome {
  via: "mediabunny" | "ffmpeg";
  note: string | null;
}

/** Encodes one still to the archive AVIF; the desktop app runs these in a pool of processes. */
export interface StillEncoder {
  encode(request: StillEncodeRequest, signal: AbortSignal): Promise<StillEncodeResult>;
}

/**
 * Decodes a still the way Gather Box's browser path does (EXIF orientation applied, 8-bit sRGB
 * RGBA) and encodes it with the archive's libavif settings. Images too large for the wasm heap go
 * to sharp's native encoder at the nearest equivalent settings.
 */
export async function encodeStillToAvif(
  sharp: SharpLibrary,
  encodeRgba: (image: RgbaImage) => Promise<ArrayBuffer>,
  request: StillEncodeRequest,
): Promise<StillEncodeResult> {
  const input = () => sharp(request.srcPath, { failOn: "none", limitInputPixels: false });
  const metadata = await input().metadata();
  const pixels = (metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0);

  if (pixels > ARCHIVE_AVIF_WASM_PIXEL_LIMIT) {
    const info = await input()
      .rotate()
      .toColourspace("srgb")
      .avif(ARCHIVE_AVIF_SHARP_OPTIONS)
      .toFile(request.outPath);

    return { width: info.width, height: info.height, bytes: info.size, encoder: "sharp" };
  }

  const { data, info } = await input()
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });

  const encoded = await encodeRgba({
    // SAFETY: sharp returns a Node Buffer, which libuv allocates over a plain ArrayBuffer; it is
    // never a SharedArrayBuffer, so viewing the same bytes avoids copying a large decode.
    data: new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  });

  await writeFile(request.outPath, new Uint8Array(encoded));
  const written = await stat(request.outPath);

  return { width: info.width, height: info.height, bytes: written.size, encoder: "wasm" };
}
