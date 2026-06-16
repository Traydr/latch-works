import type { MediaItem } from "@latch-works/media-domain";
import type { LibraryMediaItem } from "@/server/library/types";

export function readEmbeddedDeliveryUrls(media: MediaItem): {
  previewUrl?: string;
  thumbnailDeliveryToken?: string;
  thumbnailUrl?: string;
} {
  const item = media as LibraryMediaItem;

  return {
    previewUrl: item.previewUrl,
    thumbnailDeliveryToken: item.thumbnailDeliveryToken,
    thumbnailUrl: item.thumbnailUrl,
  };
}
