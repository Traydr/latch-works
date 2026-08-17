import type { MediaItem } from "@latch-works/media-domain";

/** One library media row as served to Pane View. Adds nothing to the shared domain item. */
export type LibraryMediaItem = MediaItem;

/** Offset page metadata for snapshot-style media pagination. */
export interface MediaPage {
  hasMore: boolean;
  limit: number;
  nextOffset: number | null;
  offset: number;
}
