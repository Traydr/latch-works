import { getGalleryComic, getGalleryListing } from "@/features/library/library-service";
import type {
  GalleryComic,
  GalleryComicRequest,
  GalleryListingPage,
  GalleryListingRequest,
} from "@/features/library/listing-contract";

/**
 * The only I/O the gallery browse session performs (Plan 052, Decision 3).
 * Production talks to the server functions. Gallery callers never see this.
 */
export interface GalleryPageSource {
  loadComic(request: GalleryComicRequest): Promise<GalleryComic>;
  loadPage(request: GalleryListingRequest, cursor: string | null): Promise<GalleryListingPage>;
}

export function createServerGalleryPageSource(): GalleryPageSource {
  return {
    loadComic: (request) => getGalleryComic({ data: request }),
    loadPage: (request, cursor) =>
      getGalleryListing({ data: cursor === null ? request : { ...request, cursor } }),
  };
}
