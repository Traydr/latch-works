import type { MediaItem } from "@latch-works/media-domain";
import type { MediaPage } from "./media-page";

export interface LibraryMediaItem extends MediaItem {
  previewUrl?: string;
  thumbnailUrl?: string;
}

export type { MediaPage };
