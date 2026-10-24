/** The archive stores every still image as an AVIF at this libavif quality (0–100). */
export const ARCHIVE_AVIF_QUALITY = 70;

/** libavif speed (0 slowest, 10 fastest) for archive stills. */
export const ARCHIVE_AVIF_SPEED = 6;

/**
 * The codec's wasm heap stops at 2 GiB. Hard-edged line art makes the encoder build block-matching
 * tables at speeds 6 and 7 that double its memory, so such an image fails from roughly 30
 * megapixels up. Speed 8 skips those tables and fits anything up to about 64 megapixels, for a
 * file around half again as large. Past that size no speed fits, so there is no third attempt.
 */
export const ARCHIVE_AVIF_LOW_MEMORY_SPEED = 8;

/**
 * Above this many pixels the wasm encoder cannot fit the image at any speed, so a Node consumer
 * encodes it natively with sharp instead (see {@link ARCHIVE_AVIF_SHARP_OPTIONS}).
 */
export const ARCHIVE_AVIF_WASM_PIXEL_LIMIT = 64_000_000;

/** The libavif options the wasm encoder takes; the field names match the codec's own. */
export interface AvifEncodeOptions {
  quality: number;
  qualityAlpha: number;
  denoiseLevel: number;
  tileRowsLog2: number;
  tileColsLog2: number;
  speed: number;
  subsample: number;
  chromaDeltaQ: boolean;
  sharpness: number;
  enableSharpYUV: boolean;
  tune: number;
  bitDepth: number;
}

export const ARCHIVE_AVIF_OPTIONS: AvifEncodeOptions = {
  quality: ARCHIVE_AVIF_QUALITY,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileRowsLog2: 0,
  tileColsLog2: 0,
  speed: ARCHIVE_AVIF_SPEED,
  // libavif's 4:2:0.
  subsample: 1,
  chromaDeltaQ: false,
  sharpness: 0,
  enableSharpYUV: false,
  tune: 0,
  bitDepth: 8,
};

/**
 * The closest sharp (libheif + aom) settings for images too large for the wasm encoder. sharp
 * takes `effort` 0–9 where libvips passes `9 - effort` to aom as its speed, so effort 3 is speed 6.
 * Its quality scale is libheif's rather than libavif's, so the files are close to, not identical
 * with, the wasm encoder's.
 */
export const ARCHIVE_AVIF_SHARP_OPTIONS = {
  bitdepth: 8,
  chromaSubsampling: "4:2:0",
  effort: 3,
  quality: ARCHIVE_AVIF_QUALITY,
} as const;

/** The pixel buffer the encoder reads; a canvas `ImageData` supplies exactly this. */
export interface RgbaImage {
  data: Uint8ClampedArray<ArrayBuffer> | Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

/** The one call this package needs from the libavif wasm module (`@jsquash/avif`'s encoder). */
export interface AvifCodec {
  encode(
    data: BufferSource,
    width: number,
    height: number,
    options: AvifEncodeOptions,
  ): Uint8Array | null;
}

/**
 * The source media decoded, but the encoder could not produce the converted file. The original is
 * still good, so a caller can keep it instead of failing the item.
 */
export class MediaEncodeError extends Error {
  override readonly name = "MediaEncodeError";
}

/**
 * Builds the archive AVIF encoder over a codec loader. Each environment loads the wasm its own
 * way (a fetch in the extension, a file read in Node), so the loader is injected. An encoder that
 * runs out of heap leaves its module unusable, so a failed encode drops the module and the next
 * call loads a new one.
 */
export function createArchiveAvifEncoder(
  loadCodec: () => Promise<AvifCodec>,
): (image: RgbaImage) => Promise<ArrayBuffer> {
  let codecPromise: Promise<AvifCodec> | null = null;

  const getCodec = (): Promise<AvifCodec> => {
    if (codecPromise) {
      return codecPromise;
    }

    const created = loadCodec();
    codecPromise = created;
    void created.catch(() => {
      if (codecPromise === created) {
        codecPromise = null;
      }
    });

    return created;
  };

  const encodeAtSpeed = async (image: RgbaImage, speed: number): Promise<ArrayBuffer> => {
    const codec = await getCodec();

    try {
      return encodeWithCodec(image, codec, speed);
    } catch (error) {
      // An encoder that runs out of heap returns nothing or traps ("memory access out of
      // bounds"). Either way the module is left holding a full heap in an unknown state, so the
      // next encode gets a new one.
      codecPromise = null;

      throw new MediaEncodeError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  };

  return async (image) => {
    try {
      return await encodeAtSpeed(image, ARCHIVE_AVIF_SPEED);
    } catch (error) {
      if (!(error instanceof MediaEncodeError)) {
        throw error;
      }

      return encodeAtSpeed(image, ARCHIVE_AVIF_LOW_MEMORY_SPEED);
    }
  };
}

function encodeWithCodec(image: RgbaImage, codec: AvifCodec, speed: number): ArrayBuffer {
  const encoded = codec.encode(
    new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    image.width,
    image.height,
    { ...ARCHIVE_AVIF_OPTIONS, speed },
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
