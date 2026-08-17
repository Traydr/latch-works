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
  getGalleryListing,
  getLibrarySnapshot,
  type LibrarySnapshot,
} from "./library-service";

export interface LibrarySnapshotRequest {
  comicMode: boolean;
  mediaLimit?: number;
  path: string | undefined;
  query: string | undefined;
  recursive: boolean;
}

export interface GalleryListingQueryRequest extends GalleryListingRequest {}

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
          mediaLimit: request.mediaLimit,
          path: request.path,
          query: request.query,
          recursive: request.recursive,
        },
      }),
    placeholderData: keepPreviousData,
  };
}

export function galleryListingQueryOptions(request: GalleryListingQueryRequest) {
  return {
    queryKey: galleryListingKeys.listing(request),
    queryFn: (): Promise<Awaited<ReturnType<typeof getGalleryListing>>> =>
      getGalleryListing({
        data: {
          comicMode: request.comicMode,
          cursor: request.cursor,
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
    placeholderData: keepPreviousData,
  };
}

export function useLibrarySnapshotQuery(request: LibrarySnapshotRequest) {
  return useQuery(librarySnapshotQueryOptions(request));
}

export function useGalleryListingQuery(request: GalleryListingQueryRequest) {
  return useQuery({
    ...galleryListingQueryOptions(request),
    enabled: !request.comicMode,
  });
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
