import { getFileExtension, replaceFileExtension } from "./file-names.js";

const STILL_IMAGE_EXTENSIONS = new Set(["bmp", "jpeg", "jpg", "png", "webp"]);

export type ArchiveMediaAction = "convert-avif" | "convert-mp4" | "rename-avif" | "rename-mp4";

export interface ArchiveMediaPlan {
  action: ArchiveMediaAction;
  fileName: string;
}

export function getExpectedArchiveTarget(fileName: string): string | null {
  return planFromExtension(fileName)?.fileName ?? null;
}

export function planArchiveMedia(fileName: string, mimeType: string): ArchiveMediaPlan | null {
  const extension = getFileExtension(fileName);
  const normalizedMimeType = (mimeType.toLowerCase().split(";", 1)[0] ?? "").trim();

  if (normalizedMimeType === "image/avif") {
    return extension === "avif"
      ? null
      : { action: "rename-avif", fileName: replaceFileExtension(fileName, "avif") };
  }

  if (normalizedMimeType === "video/mp4") {
    return extension === "mp4"
      ? null
      : { action: "rename-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }

  if (normalizedMimeType === "image/gif") {
    return { action: "convert-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }

  if (normalizedMimeType.startsWith("video/")) {
    return null;
  }

  if (normalizedMimeType.startsWith("image/") && normalizedMimeType !== "image/svg+xml") {
    return { action: "convert-avif", fileName: replaceFileExtension(fileName, "avif") };
  }

  return planFromExtension(fileName);
}

function planFromExtension(fileName: string): ArchiveMediaPlan | null {
  const extension = getFileExtension(fileName);

  if (extension === "gif") {
    return { action: "convert-mp4", fileName: replaceFileExtension(fileName, "mp4") };
  }

  if (STILL_IMAGE_EXTENSIONS.has(extension)) {
    return { action: "convert-avif", fileName: replaceFileExtension(fileName, "avif") };
  }

  return null;
}

/** A still or animated image on disk, decoded at its boundary. */
export interface ArchiveImageSource {
  fileName: string;
  /** The image format its bytes are, which can differ from its extension. */
  format: ArchiveImageFormat;
  /** 1 for a still; more for an animated GIF, WebP or PNG. */
  frameCount: number;
}

export type ArchiveImageFormat = "avif" | "bmp" | "gif" | "jpeg" | "png" | "webp";

/**
 * Plans an image already on disk. Unlike {@link planArchiveMedia}, which sees only a download's
 * name and MIME type, this knows the frame count: an animated GIF, WebP or PNG becomes an MP4 and
 * a single-frame one an AVIF, so animation is never flattened into a still.
 */
export function planArchiveImage(source: ArchiveImageSource): ArchiveMediaPlan | null {
  if (source.format === "avif") {
    return getFileExtension(source.fileName) === "avif"
      ? null
      : { action: "rename-avif", fileName: replaceFileExtension(source.fileName, "avif") };
  }

  if (source.frameCount > 1 && source.format !== "bmp" && source.format !== "jpeg") {
    return { action: "convert-mp4", fileName: replaceFileExtension(source.fileName, "mp4") };
  }

  return { action: "convert-avif", fileName: replaceFileExtension(source.fileName, "avif") };
}
