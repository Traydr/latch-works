import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  deleteLibraryEntry,
  type GalleryListingRequest,
  getLibrarySnapshot,
  type LibrarySnapshot,
} from "./library-service";

export interface LibrarySnapshotRequest {
  comicMode: boolean;
  /** Direct-child subtrees excluded from recursive/comic aggregation (Plan 054). */
  excludedPaths?: readonly string[];
  mediaLimit?: number;
  path: string | undefined;
  query: string | undefined;
  recursive: boolean;
}

export interface GalleryListingQueryRequest extends GalleryListingRequest {}

/**
 * Listing pages are fetched by the browse session through its page source;
 * these keys exist so delete/refresh invalidation reaches page 1.
 */

export const librarySnapshotKeys = {
  all: ["library-snapshot"] as const,
  snapshot: (request: LibrarySnapshotRequest) => [...librarySnapshotKeys.all, request] as const,
};

export const galleryListingKeys = {
  all: ["gallery-listing"] as const,
  listing: (request: GalleryListingQueryRequest) => [...galleryListingKeys.all, request] as const,
};

export function librarySnapshotQueryOptions(request: LibrarySnapshotRequest) {
  return {
    queryKey: librarySnapshotKeys.snapshot(request),
    queryFn: (): Promise<LibrarySnapshot> =>
      getLibrarySnapshot({
        data: {
          comicMode: request.comicMode,
          excludedPaths: request.excludedPaths ? [...request.excludedPaths] : undefined,
          mediaLimit: request.mediaLimit,
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

export function useLibrarySnapshotSuspense(request: LibrarySnapshotRequest) {
  return useSuspenseQuery(librarySnapshotQueryOptions(request));
}

export function useInvalidateLibrarySnapshot() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all }),
      queryClient.invalidateQueries({ queryKey: galleryListingKeys.all }),
    ]);
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
