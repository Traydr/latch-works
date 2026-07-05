import {
  headStoredObject,
  originalObjectKey,
  readStoredObjectBytes,
} from "@latch-works/media-storage";
import ffmpegStaticPath from "ffmpeg-static";
import { DEFAULT_MAX_SOURCE_BYTES } from "./descriptor.js";
import { resizeImageToWebp } from "./image.js";
import { renderPdfCoverPage } from "./pdf.js";
import type { GenerateDerivativeOptions, GeneratedDerivative } from "./types.js";
import { extractVideoPosterFrameFromStorage, runFfmpeg } from "./video.js";

/**
 * Reads the source original from storage and produces a resized WebP derivative.
 * Pure with respect to the database: callers own the `thumbnails` lifecycle and
 * the upload of the returned bytes. Shared by Pane View inline generation and
 * the media-optimizer service.
 */
export async function generateDerivativeBytes(
  options: GenerateDerivativeOptions,
): Promise<GeneratedDerivative> {
  const { size, source, storage } = options;
  const maxBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const ffmpegRunner = options.ffmpegRunner ?? runFfmpeg;
  const ffmpegPath = options.ffmpegPath ?? ffmpegStaticPath;

  const sourceKey =
    source.originalObjectKey ??
    originalObjectKey({
      extension: source.extension,
      mediaType: source.mediaType,
      sha256: source.sha256,
    });

  if (source.mediaType === "video") {
    const posterFrame = await extractVideoPosterFrameFromStorage({
      extension: source.extension,
      ffmpegPath,
      ffmpegRunner,
      maxBytes,
      sourceKey,
      storage,
    });
    return resizeImageToWebp(posterFrame, size);
  }

  if (source.mediaType === "pdf") {
    const sourceHead = await headStoredObject({ key: sourceKey, storage });
    if (!sourceHead) {
      throw new Error(`original object missing: ${sourceKey}`);
    }
    if (sourceHead.contentLength > maxBytes) {
      throw new Error(`original object exceeds ${maxBytes} bytes`);
    }
    const pdfBytes = await readStoredObjectBytes({ key: sourceKey, storage });
    if (!pdfBytes) {
      throw new Error(`original object missing: ${sourceKey}`);
    }
    const coverPng = await renderPdfCoverPage(pdfBytes, maxBytes);
    return resizeImageToWebp(coverPng, size);
  }

  const sourceHead = await headStoredObject({ key: sourceKey, storage });
  if (!sourceHead) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  if (sourceHead.contentLength > maxBytes) {
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  const sourceBytes = await readStoredObjectBytes({ key: sourceKey, storage });
  if (!sourceBytes) {
    throw new Error(`original object missing: ${sourceKey}`);
  }

  if (sourceBytes.byteLength > maxBytes) {
    throw new Error(`original object exceeds ${maxBytes} bytes`);
  }

  return resizeImageToWebp(sourceBytes, size);
}
