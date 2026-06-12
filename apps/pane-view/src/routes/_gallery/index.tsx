import { createFileRoute } from "@tanstack/react-router";
import {
  type GalleryBrowseSearch,
  parseGalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import { GalleryPage } from "@/features/gallery/GalleryPage";
import {
  librarySnapshotQueryOptions,
  toLibrarySnapshotRequest,
} from "@/features/library/library-queries";

export const Route = createFileRoute("/_gallery/")({
  validateSearch: (search): GalleryBrowseSearch => parseGalleryBrowseSearch(search),
  loaderDeps: ({ search }) => toLibrarySnapshotRequest(search),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(librarySnapshotQueryOptions(deps));
  },
  component: GalleryPage,
});
