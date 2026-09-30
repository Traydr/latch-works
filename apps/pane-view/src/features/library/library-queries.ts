import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteLibraryEntry,
  type GalleryListingRequest,
  getLibrarySnapshot,
  type LibrarySnapshot,
} from "./library-service";

export interface LibrarySnapshotRequest {
  comicMode: boolean;
  path: string | undefined;
  query: string | undefined;
  recursive: boolean;
}

export interface GalleryListingQueryRequest extends GalleryListingRequest {}

/**
 * Listing pages are fetched by the browse session through its page source.
 * One key holds every loaded page of a listing, so delete and refresh
 * invalidation re-read them together.
 */

export const librarySnapshotKeys = {
  all: ["library-snapshot"] as const,
  snapshot: (request: LibrarySnapshotRequest) => [...librarySnapshotKeys.all, request] as const,
};

export const galleryListingKeys = {
  all: ["gallery-listing"] as const,
  listing: (request: GalleryListingQueryRequest) => [...galleryListingKeys.all, request] as const,
};

/** Complete comics the reader opened; Refresh invalidates them with the listing. */
export const galleryComicKeys = {
  all: ["gallery-comic"] as const,
  comic: (comicId: string, request: GalleryListingQueryRequest) =>
    [
      ...galleryComicKeys.all,
      comicId,
      request.path ?? "",
      request.query ?? "",
      request.showImages,
      request.showVideos,
    ] as const,
};

export function librarySnapshotQueryOptions(request: LibrarySnapshotRequest) {
  return {
    queryKey: librarySnapshotKeys.snapshot(request),
    queryFn: (): Promise<LibrarySnapshot> =>
      getLibrarySnapshot({
        data: {
          comicMode: request.comicMode,
          path: request.path,
          query: request.query,
          recursive: request.recursive,
        },
      }),
    placeholderData: keepPreviousData,
  };
}

export function useLibrarySnapshotQuery(request: LibrarySnapshotRequest) {
  return useQuery(librarySnapshotQueryOptions(request));
}

export function useDeleteLibraryEntryMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (entryId: string) => deleteLibraryEntry({ data: { entryId } }),
    onSuccess: (result) => {
      if (result.deleted) {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all }),
          queryClient.invalidateQueries({ queryKey: galleryListingKeys.all }),
        ]);
      }
    },
  });
}
