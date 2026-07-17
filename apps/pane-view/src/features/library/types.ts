import type { MediaItem } from "@latch-works/media-domain";

/** Client contract for library media rows used by gallery/features. */
export interface LibraryMediaItem extends MediaItem {}

/** Offset page metadata for snapshot-style media pagination. */
export interface MediaPage {
  hasMore: boolean;
  limit: number;
  nextOffset: number | null;
  offset: number;
}

/**
 * Unified browse pagination for gallery load-more.
 * Listing mode uses `cursor`; comic/snapshot mode uses `nextOffset`.
 */
export interface GalleryBrowsePage {
  cursor: string | null;
  hasMore: boolean;
  limit: number;
  nextOffset: number | null;
}
