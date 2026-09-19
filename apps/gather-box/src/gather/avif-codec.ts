import createAvifEncoder, {
  type AVIFModule,
  type EncodeOptions as AvifEncodeOptions
} from "@jsquash/avif/codec/enc/avif_enc.js";
import { MediaEncodeError, toError } from "./errors";

export const ARCHIVE_AVIF_QUALITY = 70;

export const ARCHIVE_AVIF_SPEED = 6;

/**
 * The codec's wasm heap stops at 2 GiB. Hard-edged line art makes the encoder build block-matching
 * tables at speeds 6 and 7 that double its memory, so such an image fails from roughly 30
 * megapixels up. Speed 8 skips those tables and fits anything up to about 64 megapixels, for a
 * file around half again as large. Past that size no speed fits, so there is no third attempt.
 */
export const ARCHIVE_AVIF_LOW_MEMORY_SPEED = 8;

export const ARCHIVE_AVIF_OPTIONS: AvifEncodeOptions = {
  quality: ARCHIVE_AVIF_QUALITY,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileRowsLog2: 0,
  tileColsLog2: 0,
  speed: ARCHIVE_AVIF_SPEED,
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  enableSharpYUV: false,
  tune: 0,
  bitDepth: 8
};

/** The pixel buffer the encoder reads; a canvas `ImageData` supplies exactly this. */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

let encoderPromise: Promise<AVIFModule> | null = null;

export async function encodeAvifImageData(imageData: RgbaImage): Promise<ArrayBuffer> {
  try {
    return await encodeAtSpeed(imageData, ARCHIVE_AVIF_SPEED);
  } catch (error) {
    if (!(error instanceof MediaEncodeError)) {
      throw error;
    }

    return encodeAtSpeed(imageData, ARCHIVE_AVIF_LOW_MEMORY_SPEED);
  }
}

async function encodeAtSpeed(imageData: RgbaImage, speed: number): Promise<ArrayBuffer> {
  const encoder = await getAvifEncoder();

  try {
    return encodeWithAvifModule(imageData, encoder, speed);
  } catch (error) {
    // An encoder that runs out of heap returns nothing or traps ("memory access out of bounds").
    // Either way the module is left holding a full heap in an unknown state, so the next encode
    // gets a new one.
    encoderPromise = null;

    throw new MediaEncodeError(toError(error).message, { cause: error });
  }
}

function encodeWithAvifModule(
  imageData: RgbaImage,
  encoder: Pick<AVIFModule, "encode">,
  speed: number
): ArrayBuffer {
  const encoded = encoder.encode(
    new Uint8Array(imageData.data.buffer),
    imageData.width,
    imageData.height,
    { ...ARCHIVE_AVIF_OPTIONS, speed }
  );

  if (!encoded) {
    throw new Error("The AVIF encoder did not produce an image.");
  }

  // The encoder writes into wasm memory, so the bytes are copied into an ArrayBuffer this
  // caller owns rather than handing back a view over the module's heap.
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);

  return buffer;
}

function getAvifEncoder(): Promise<AVIFModule> {
  if (encoderPromise) {
    return encoderPromise;
  }

  const created = createEncoder();
  encoderPromise = created;
  void created.catch(() => {
    if (encoderPromise === created) {
      encoderPromise = null;
    }
  });

  return created;
}

async function createEncoder(): Promise<AVIFModule> {
  const wasmUrl = new URL("../codecs/avif_enc.wasm", import.meta.url);
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Could not load the AVIF encoder (${response.status}).`);
  }

  return createAvifEncoder({
    wasmBinary: await response.arrayBuffer(),
    noInitialRun: true
  });
}
