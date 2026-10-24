import createAvifEncoder from "@jsquash/avif/codec/enc/avif_enc.js";
import { createArchiveAvifEncoder } from "@latch-works/media-format";

/**
 * The archive AVIF encoder (quality, speed and the low-memory retry live in
 * `@latch-works/media-format`) over the libavif wasm the build copies into `codecs/`.
 */
export const encodeAvifImageData = createArchiveAvifEncoder(async () => {
  const wasmUrl = new URL("../codecs/avif_enc.wasm", import.meta.url);
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Could not load the AVIF encoder (${response.status}).`);
  }

  return createAvifEncoder({
    wasmBinary: await response.arrayBuffer(),
    noInitialRun: true
  });
});
