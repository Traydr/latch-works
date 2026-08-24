import type { ComicEntry } from "@latch-works/media-domain";
import type { GalleryListingQueryRequest } from "@/features/library/library-queries";
import {
  type GalleryComicRequest,
  getGalleryComic,
  getGalleryListing,
} from "@/features/library/library-service";
import type { LibraryMediaItem } from "@/features/library/types";
import type { GalleryListingPage } from "../../server/library/gallery-listing";

/**
 * The only I/O the gallery browse session performs (Plan 052, Decision 3).
 * Production talks to the server functions; tests inject an in-memory
 * adapter (gallery-page-source.memory.ts). Gallery callers never see this.
 */
export interface GalleryPageSource {
  loadComic(request: GalleryComicRequest): Promise<ComicEntry<LibraryMediaItem>>;
  loadPage(request: GalleryListingQueryRequest): Promise<GalleryListingPage>;
}

export type { GalleryComicRequest };

export function createServerGalleryPageSource(): GalleryPageSource {
  return {
    loadComic: (request) => getGalleryComic({ data: request }),
    loadPage: (request) =>
      getGalleryListing({
        data: {
          comicMode: request.comicMode,
          cursor: request.cursor,
          excludedPaths: request.excludedPaths ? [...request.excludedPaths] : undefined,
          limit: request.limit,
          path: request.path,
          query: request.query,
          randomSeed: request.randomSeed,
          recursive: request.recursive,
          showImages: request.showImages,
          showVideos: request.showVideos,
          sortMode: request.sortMode,
        },
      }),
  };
}
