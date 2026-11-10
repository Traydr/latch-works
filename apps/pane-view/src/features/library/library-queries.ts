import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteLibraryEntry, getLibrarySnapshot } from "./library-service";
import type {
  GalleryComicRequest,
  GalleryListingRequest,
  LibrarySnapshotRequest,
} from "./listing-contract";

export const librarySnapshotKeys = {
  all: ["library-snapshot"] as const,
  snapshot: (request: LibrarySnapshotRequest) => [...librarySnapshotKeys.all, request] as const,
};

/**
 * One key holds every loaded page of a listing, so delete and refresh
 * invalidation re-read them together. The request is the normalized one
 * (normalizeListingRequest), so equal populations share a key.
 */
export const galleryListingKeys = {
  all: ["gallery-listing"] as const,
  listing: (request: GalleryListingRequest) => [...galleryListingKeys.all, request] as const,
};

/**
 * The identity of one browse population, as a string: when it changes,
 * accumulated pages, pagination state, and thumbnail resolution start over.
 */
export function browseKeyFor(request: GalleryListingRequest): string {
  return JSON.stringify(galleryListingKeys.listing(request));
}

/** Complete comics the reader opened; Refresh invalidates them with the listing. */
export const galleryComicKeys = {
  all: ["gallery-comic"] as const,
  comic: (request: GalleryComicRequest) => [...galleryComicKeys.all, request] as const,
};

/** Every query a library change can make stale: the snapshot, listings, and opened comics. */
const libraryContentKeys = [librarySnapshotKeys.all, galleryListingKeys.all, galleryComicKeys.all];

export function invalidateLibraryContent(
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  return Promise.all(
    libraryContentKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);
}

export function librarySnapshotQueryOptions(request: LibrarySnapshotRequest) {
  return {
    queryKey: librarySnapshotKeys.snapshot(request),
    queryFn: () => getLibrarySnapshot({ data: request }),
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
        void invalidateLibraryContent(queryClient);
      }
    },
  });
}
