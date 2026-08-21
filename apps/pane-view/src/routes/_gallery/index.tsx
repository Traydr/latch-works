import { createFileRoute } from "@tanstack/react-router";
import { GalleryBrowseSearchSchema } from "@/features/gallery/browse-search";
import { GalleryPage } from "@/features/gallery/GalleryPage";
import { browseSnapshotRequestFromSearch } from "@/features/gallery/useGalleryBrowseState";
import { librarySnapshotQueryOptions } from "@/features/library/library-queries";

export const Route = createFileRoute("/_gallery/")({
  validateSearch: GalleryBrowseSearchSchema,
  loaderDeps: ({ search }) => browseSnapshotRequestFromSearch(search),
  ssr: false,
  // The snapshot feeds the sidebar; the grid comes from the cursor listing in
  // useGalleryBrowse. This loader is what `defaultPreload: "intent"` runs to
  // warm the snapshot for links into the route. It must not await: on an
  // ordinary navigation the component's own query issues the same request at
  // the same moment, so awaiting here only holds the component — and with it
  // the listing request — for a whole round trip.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(librarySnapshotQueryOptions(deps));
  },
  component: GalleryPage,
});
