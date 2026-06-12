import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { GalleryBrowseSearch } from "@/features/gallery/browse-search";
import { deleteLibraryEntry, getLibrarySnapshot, type LibrarySnapshot } from "./library-service";

export interface LibrarySnapshotRequest {
  comicMode: boolean;
  path: string | undefined;
  query: string | undefined;
  recursive: boolean;
}

export const librarySnapshotKeys = {
  all: ["library-snapshot"] as const,
  snapshot: (request: LibrarySnapshotRequest) => [...librarySnapshotKeys.all, request] as const,
};

export function toLibrarySnapshotRequest(search: GalleryBrowseSearch): LibrarySnapshotRequest {
  return {
    comicMode: search.comic ?? false,
    path: search.path,
    query: search.q,
    recursive: search.recursive ?? false,
  };
}

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

export function useLibrarySnapshotSuspense(request: LibrarySnapshotRequest) {
  return useSuspenseQuery(librarySnapshotQueryOptions(request));
}

export function useInvalidateLibrarySnapshot() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all });
}

export function useDeleteLibraryEntryMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (entryId: string) => deleteLibraryEntry({ data: { entryId } }),
    onSuccess: (result) => {
      if (result.deleted) {
        void queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all });
      }
    },
  });
}
