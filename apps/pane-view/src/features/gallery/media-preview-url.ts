import type { MediaItem } from "@latch-works/media-domain";

export function readMediaPreviewUrl(media: MediaItem): string | undefined {
  if ("thumbnailUrl" in media && typeof media.thumbnailUrl === "string" && media.thumbnailUrl) {
    return media.thumbnailUrl;
  }

  if (media.mediaType === "gif") {
    return `/api/media/${media.id}/thumbnail?size=320`;
  }

  if (media.mediaType === "image") {
    return `/api/media/${media.id}/original`;
  }

  return undefined;
}
