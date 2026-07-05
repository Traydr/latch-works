import { createFileRoute } from "@tanstack/react-router";
import {
  type GalleryBrowseSearch,
  parseGalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import { GalleryPage } from "@/features/gallery/GalleryPage";
import {
  librarySnapshotQueryOptions,
  toGalleryRouteLoaderDeps,
} from "@/features/library/library-queries";

export const Route = createFileRoute("/_gallery/")({
  ssr: false,
  validateSearch: (search): GalleryBrowseSearch => parseGalleryBrowseSearch(search),
  loaderDeps: ({ search }) => toGalleryRouteLoaderDeps(search),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(librarySnapshotQueryOptions(deps));
  },
  component: GalleryPage,
});
