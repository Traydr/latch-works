import type { MediaItem } from "@latch-works/media-domain";
import { buildThumbnailRequestUrl, DEFAULT_CARD_WIDTH } from "./thumbnail-size";

export function readMediaPreviewUrl(
  media: MediaItem,
  cardWidth: number = DEFAULT_CARD_WIDTH,
): string | undefined {
  if (media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video") {
    return buildThumbnailRequestUrl(media.id, cardWidth);
  }

  return undefined;
}

export function readMediaOriginalUrl(media: MediaItem): string {
  return `/api/media/${media.id}/original`;
}

export function readMediaViewerUrl(media: MediaItem): string {
  if (media.mediaType === "image") {
    return `/api/media/${media.id}/preview`;
  }

  return readMediaOriginalUrl(media);
}
