import { createFileRoute } from "@tanstack/react-router";
import {
  type GalleryBrowseSearch,
  parseGalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import { GalleryPage } from "@/features/gallery/GalleryPage";
import { browseSnapshotRequestFromSearch } from "@/features/gallery/useGalleryBrowseState";
import { librarySnapshotQueryOptions } from "@/features/library/library-queries";

export const Route = createFileRoute("/_gallery/")({
  validateSearch: (search): GalleryBrowseSearch => parseGalleryBrowseSearch(search),
  loaderDeps: ({ search }) => browseSnapshotRequestFromSearch(search),
  ssr: false,
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(librarySnapshotQueryOptions(deps));
  },
  component: GalleryPage,
});
