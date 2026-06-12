import { Outlet, getRouteApi } from "@tanstack/react-router";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ArchiveSidebar } from "@/features/gallery/ArchiveSidebar";
import {
  displayPathFromSearch,
  type GalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import {
  toLibrarySnapshotRequest,
  useLibrarySnapshotQuery,
} from "@/features/library/library-queries";
import { GalleryShellProvider, useGalleryShell } from "@/features/gallery/gallery-shell-context";
import { ThemeSync } from "@/features/settings/ThemeSync";
import { useAppSettings } from "@/features/settings/useAppSettings";
import { useHydrated } from "@/hooks/use-hydrated";

const galleryIndexRoute = getRouteApi("/_gallery/");

function GalleryLayoutContent() {
  const search = galleryIndexRoute.useSearch();
  const navigate = galleryIndexRoute.useNavigate();
  const { settings } = useAppSettings();
  const { requestOpenSettings } = useGalleryShell();
  const displayPath = displayPathFromSearch(search.path);
  const snapshotRequest = toLibrarySnapshotRequest(search);
  const { data: library, isFetching } = useLibrarySnapshotQuery(snapshotRequest);
  const hydrated = useHydrated();
  const showFetching = hydrated && isFetching;
  const folders = library?.folders ?? [];

  const navigateToPath = (path: string) => {
    void navigate({
      search: (current: GalleryBrowseSearch) => ({
        comic: current.comic,
        media: undefined,
        path: path || undefined,
        q: current.q,
        recursive: path ? current.recursive : undefined,
      }),
      to: "/",
    });
  };

  return (
    <SidebarProvider
      className="min-h-screen overflow-hidden bg-background text-foreground"
      defaultOpen
    >
      <ThemeSync theme={settings.theme} />
      <ArchiveSidebar
        currentPath={displayPath}
        folders={folders}
        isLoading={showFetching}
        onNavigateToPath={navigateToPath}
        onOpenSettings={requestOpenSettings}
      />

      <SidebarInset className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

export function GalleryLayout() {
  return (
    <GalleryShellProvider>
      <GalleryLayoutContent />
    </GalleryShellProvider>
  );
}
