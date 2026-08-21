import { getRouteApi, Outlet } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ArchiveSidebar } from "@/features/gallery/ArchiveSidebar";
import { GalleryLayoutProvider } from "@/features/gallery/gallery-layout-context";
import { useGalleryBrowseState } from "@/features/gallery/useGalleryBrowseState";
import { useLibrarySnapshotQuery } from "@/features/library/library-queries";
import { ThemeSync } from "@/features/settings/ThemeSync";
import { useAppSettings } from "@/features/settings/useAppSettings";
import { useHydrated } from "@/hooks/use-hydrated";

const galleryIndexRoute = getRouteApi("/_gallery/");

export function GalleryLayout() {
  const search = galleryIndexRoute.useSearch();
  const navigate = galleryIndexRoute.useNavigate();
  const { settings, updateSettings } = useAppSettings();
  const browse = useGalleryBrowseState({ navigate, search, settings });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The sidebar shares the page's snapshot key, so one request serves both
  // and the sidebar never fetches media rows.
  const {
    data: library,
    isFetching,
    isPlaceholderData,
  } = useLibrarySnapshotQuery(browse.snapshotRequest);
  const hydrated = useHydrated();
  const showFetching = hydrated && isFetching;
  const folders = library?.folders ?? [];
  // While keepPreviousData shows the folder being left, its children stay
  // visible but inert: activating one would navigate somewhere the user
  // cannot see selected.
  const foldersDisabled = isPlaceholderData;

  const layoutValue = useMemo(
    () => ({ browse, setSettingsOpen, settings, settingsOpen, updateSettings }),
    [browse, settings, settingsOpen, updateSettings],
  );

  return (
    <GalleryLayoutProvider value={layoutValue}>
      <SidebarProvider
        className="h-dvh max-h-dvh min-h-0 overflow-hidden bg-background text-foreground"
        defaultOpen
      >
        <ThemeSync theme={settings.theme} />
        <ArchiveSidebar
          currentPath={browse.path}
          folders={folders}
          foldersDisabled={foldersDisabled}
          isLoading={showFetching}
          onNavigateToPath={browse.navigateToPath}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <SidebarInset className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </GalleryLayoutProvider>
  );
}
