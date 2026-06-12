import { snapThumbnailSize } from "@latch-works/media-delivery";

export function buildMediaApiUrl(
  mediaId: string,
  variant: "thumbnail" | "preview" | "original",
  size?: number,
): string {
  if (variant === "original") {
    return `/api/media/${mediaId}/original`;
  }

  if (variant === "preview") {
    return `/api/media/${mediaId}/preview`;
  }

  return `/api/media/${mediaId}/thumbnail?size=${snapThumbnailSize(size ?? 320)}`;
}
