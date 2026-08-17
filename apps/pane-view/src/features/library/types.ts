export type { LibraryMediaItem, MediaPage } from "../../server/library/types";

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
