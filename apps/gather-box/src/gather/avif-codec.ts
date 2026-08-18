import createAvifEncoder, {
  type AVIFModule,
  type EncodeOptions as AvifEncodeOptions
} from "@jsquash/avif/codec/enc/avif_enc.js";

export const ARCHIVE_AVIF_QUALITY = 70;
export const ARCHIVE_AVIF_SPEED = 6;

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

let encoderPromise: Promise<AVIFModule> | null = null;

export async function encodeAvifImageData(imageData: ImageData): Promise<ArrayBuffer> {
  const encoder = await getAvifEncoder();
  return encodeWithAvifModule(imageData, encoder);
}

export function encodeWithAvifModule(
  imageData: ImageData,
  encoder: Pick<AVIFModule, "encode">
): ArrayBuffer {
  const encoded = encoder.encode(
    new Uint8Array(imageData.data.buffer),
    imageData.width,
    imageData.height,
    ARCHIVE_AVIF_OPTIONS
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
