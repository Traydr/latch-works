import type { ThumbnailSize } from "@latch-works/media-delivery";
import type { MediaType } from "@latch-works/media-domain";
import { previewObjectKey, thumbnailObjectKey } from "@latch-works/media-storage";
import type { DerivativeSource } from "./types.js";

export const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

export interface DerivativeDescriptor {
  objectKey: string;
  purpose: "preview" | "thumbnail";
}

export function supportsDerivative(mediaType: MediaType): boolean {
  return (
    mediaType === "video" || mediaType === "image" || mediaType === "gif" || mediaType === "pdf"
  );
}

export function supportsInlineImageThumbnail(mediaType: MediaType): boolean {
  return mediaType === "image" || mediaType === "gif";
}

export function buildDerivativeDescriptor(
  source: DerivativeSource,
  size: ThumbnailSize,
): DerivativeDescriptor {
  if (source.mediaType === "video" || source.mediaType === "pdf") {
    return {
      objectKey: previewObjectKey({
        extension: source.extension,
        mediaType: source.mediaType,
        sha256: source.sha256,
        size,
      }),
      purpose: "preview",
    };
  }

  return {
    objectKey: thumbnailObjectKey({
      extension: source.extension,
      mediaType: source.mediaType,
      sha256: source.sha256,
      size,
    }),
    purpose: "thumbnail",
  };
}
