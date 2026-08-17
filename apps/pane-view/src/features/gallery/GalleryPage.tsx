import type { BrowserEntry, ComicEntry } from "@latch-works/media-domain";
import { Archive, ChevronUp, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import {
  createContext,
  type FormEvent,
  Fragment,
  type JSX,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ComicReader } from "@/features/comics/ComicReader";
import { buildBreadcrumbItems, getParentPath } from "@/features/gallery/browse-search";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryBrowsePane } from "@/features/gallery/GalleryBrowsePane";
import { GalleryGridSkeleton } from "@/features/gallery/GalleryGridSkeleton";
import { useGalleryLayout } from "@/features/gallery/gallery-layout-context";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { useGalleryBrowse } from "@/features/gallery/useGalleryBrowse";
import { useGalleryKeyboard } from "@/features/gallery/useGalleryKeyboard";
import { useGalleryViewerHandoff } from "@/features/gallery/useGalleryViewerHandoff";
import {
  useDeleteLibraryEntryMutation,
  useInvalidateLibrarySnapshot,
} from "@/features/library/library-queries";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-mobile";

function useGalleryPage() {
  const hydrated = useHydrated();
  const invalidateLibrary = useInvalidateLibrarySnapshot();
  const deleteEntryMutation = useDeleteLibraryEntryMutation();
  const { browse, settings, settingsOpen, setSettingsOpen, updateSettings } = useGalleryLayout();
  const {
    comicMode: effectiveComicMode,
    detailPanelOpen,
    folderModesEnabled,
    listingRequest,
    navigateToPath,
    path: displayPath,
    query,
    recursive: effectiveRecursive,
    selectMedia,
    selectedId,
    setComicMode,
    setDetailPanelOpen,
    setRecursive,
    setSortMode,
    shuffle,
    snapshotRequest,
    sortMode,
  } = browse;
  const isMobile = useIsMobile();

  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);
  const [searchDraft, setSearchDraft] = useState(query ?? "");
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollRequestKey, setScrollRequestKey] = useState(0);
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletedEntryIds, setDeletedEntryIds] = useState<ReadonlySet<string>>(() => new Set());

  const {
    allMedia,
    browseKey,
    entries,
    handleLoadMoreMedia,
    isReady,
    library,
    loadingMoreMedia,
    mediaPage,
    showFetching,
    visibleMedia,
  } = useGalleryBrowse({
    displayPath,
    effectiveComicMode,
    effectiveRecursive,
    hydrated,
    listingRequest,
    showImages: settings.showImages,
    showVideos: settings.showVideos,
    snapshotRequest,
  });

  const { viewerOpen, viewerItems, viewerLockedMediaId, openViewer, closeViewer } =
    useGalleryViewerHandoff(selectMedia);

  const showDetailPanel = !isMobile && detailPanelOpen;
  const columnCountRef = useRef(4);

  useEffect(() => {
    setSearchDraft(query ?? "");
  }, [query]);

  useEffect(() => {
    setFocusedEntryIndex((currentIndex) => {
      if (entries.length === 0) {
        return 0;
      }

      return Math.min(currentIndex, entries.length - 1);
    });
  }, [entries]);

  const navigableMedia = useMemo(
    () => visibleMedia.filter((item) => !deletedEntryIds.has(item.id)),
    [deletedEntryIds, visibleMedia],
  );

  const selected =
    visibleMedia.find((item) => item.id === (viewerLockedMediaId ?? selectedId)) ??
    navigableMedia[0] ??
    visibleMedia[0] ??
    null;
  const selectedIndex = selected ? navigableMedia.findIndex((item) => item.id === selected.id) : -1;

  useEffect(() => {
    if (!library) {
      return;
    }

    setDeletedEntryIds((current) => {
      const liveIds = new Set(allMedia.map((item) => item.id));
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setDeletingEntryIds((current) => {
      const liveIds = new Set(allMedia.map((item) => item.id));
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [allMedia, library]);

  const navigateSiblingFolder = useCallback(
    (offset: -1 | 1) => {
      if (!library) {
        return;
      }

      const siblings = library.folders;
      const currentIndex = siblings.findIndex((f) => f.path === displayPath);
      if (currentIndex < 0) {
        return;
      }

      const nextIndex = (currentIndex + offset + siblings.length) % siblings.length;
      const next = siblings[nextIndex];
      if (next) {
        navigateToPath(next.path);
      }
    },
    [displayPath, library, navigateToPath],
  );

  const handleActivateEntry = useCallback(
    (entry: BrowserEntry) => {
      if (entry.kind === "folder") {
        navigateToPath(entry.path);
      } else if (entry.kind === "comic") {
        setActiveComic(entry.comic);
      } else {
        openViewer(visibleMedia, entry.media.id);
      }
    },
    [navigateToPath, openViewer, visibleMedia],
  );

  const closeOverlays = useCallback(() => {
    setSettingsOpen(false);
    setHotkeysOpen(false);
    setMobileSearchOpen(false);
    setPathSheetOpen(false);
  }, [setSettingsOpen]);

  const openHotkeys = useCallback(() => {
    setHotkeysOpen(true);
  }, []);
  const requestScrollFocusedIntoView = useCallback(() => {
    setScrollRequestKey((current) => current + 1);
  }, []);

  useGalleryKeyboard({
    columnCountRef,
    displayPath,
    entries,
    focusedEntryIndex,
    hotkeysOpen,
    mobileSearchOpen,
    onActivateEntry: handleActivateEntry,
    onCloseOverlays: closeOverlays,
    onNavigateSiblingFolder: navigateSiblingFolder,
    onNavigateToPath: navigateToPath,
    onOpenHotkeys: openHotkeys,
    onSelectMedia: selectMedia,
    pathSheetOpen,
    setFocusedEntryIndex,
    requestScrollFocusedIntoView,
    settingsOpen,
    viewerOpen,
  });

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    browse.submitSearch(searchDraft);
  };

  const selectAdjacentMedia = (offset: -1 | 1) => {
    if (viewerLockedMediaId || !navigableMedia.length) {
      return;
    }

    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = (currentIndex + offset + navigableMedia.length) % navigableMedia.length;
    const next = navigableMedia[nextIndex];
    if (next) {
      selectMedia(next.id);
    }
  };

  const deleteSelectedMedia = () => {
    if (!selected || deletedEntryIds.has(selected.id) || deletingEntryIds.has(selected.id)) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${selected.name}" from the archive? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    const entryId = selected.id;
    const currentNavigableIndex = navigableMedia.findIndex((item) => item.id === entryId);

    setDeletingEntryIds((current) => new Set([...current, entryId]));

    void (async () => {
      try {
        const result = await deleteEntryMutation.mutateAsync(entryId);
        if (!result.deleted) {
          return;
        }

        setDeletedEntryIds((current) => new Set([...current, entryId]));

        const remaining = navigableMedia.filter((item) => item.id !== entryId);
        const nextIndex =
          remaining.length > 0
            ? currentNavigableIndex >= 0
              ? Math.min(currentNavigableIndex, remaining.length - 1)
              : 0
            : -1;
        const next = nextIndex >= 0 ? remaining[nextIndex] : undefined;
        if (next) {
          selectMedia(next.id);
        }
      } finally {
        setDeletingEntryIds((current) => {
          const next = new Set(current);
          next.delete(entryId);
          return next;
        });
      }
    })();
  };

  const handleSelectEntry = (entry: BrowserEntry) => {
    const entryIndex = entries.findIndex((candidate) => candidate.key === entry.key);
    if (entryIndex >= 0) {
      setFocusedEntryIndex(entryIndex);
    }

    if (entry.kind === "folder") {
      navigateToPath(entry.path);
    } else if (entry.kind === "comic") {
      selectMedia(entry.comic.cover.id);
    } else {
      selectMedia(entry.media.id);
    }
  };

  const breadcrumbs = useMemo(() => buildBreadcrumbItems(displayPath), [displayPath]);
  const archiveRoot = library?.archiveRoot ?? "Synced archive";
  const currentFolderName = breadcrumbs[breadcrumbs.length - 1]?.label ?? archiveRoot;
  const parentPath = getParentPath(displayPath);

  return {
    activeComic,
    archiveRoot,
    breadcrumbs,
    browseKey,
    closeViewer,
    columnCountRef,
    currentFolderName,
    deleteSelectedMedia,
    deletedEntryIds,
    deletingEntryIds,
    displayPath,
    effectiveComicMode,
    effectiveRecursive,
    entries,
    focusedEntryIndex,
    folderModesEnabled,
    handleActivateEntry,
    handleLoadMoreMedia,
    handleSelectEntry,
    hotkeysOpen,
    invalidateLibrary,
    isMobile,
    isReady,
    loadingMoreMedia,
    mediaPage,
    mobileSearchOpen,
    navigateSiblingFolder,
    navigateToPath,
    navigableMedia,
    openViewer,
    parentPath,
    pathSheetOpen,
    scrollRequestKey,
    searchDraft,
    selectAdjacentMedia,
    selected,
    setActiveComic,
    setComicMode,
    setDetailPanelOpen,
    setHotkeysOpen,
    setMobileSearchOpen,
    setPathSheetOpen,
    setRecursive,
    setSearchDraft,
    setSettingsOpen,
    setSortMode,
    settings,
    settingsOpen,
    showDetailPanel,
    showFetching,
    shuffle,
    sortMode,
    submitSearch,
    updateSettings,
    viewerItems,
    viewerLockedMediaId,
    viewerOpen,
    visibleMedia,
  };
}

type GalleryPageModel = ReturnType<typeof useGalleryPage>;
const GalleryPageContext = createContext<GalleryPageModel | null>(null);

function useGalleryPageModel(): GalleryPageModel {
  const model = useContext(GalleryPageContext);
  if (!model) throw new Error("Gallery page context is missing");
  return model;
}

export function GalleryPage(): JSX.Element {
  const model = useGalleryPage();
  return (
    <GalleryPageContext.Provider value={model}>
      <GalleryHeader />
      <GalleryContent />
      <GalleryOverlays />
    </GalleryPageContext.Provider>
  );
}

function GalleryHeader(): JSX.Element {
  const model = useGalleryPageModel();
  return (
    <header className="flex h-auto min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SidebarTrigger className="-ml-1 shrink-0" />
        {model.isMobile ? <MobilePathHeader /> : <DesktopPathHeader />}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          className="md:hidden"
          onClick={() => model.setMobileSearchOpen(true)}
          size="icon"
          type="button"
          variant="outline"
        >
          <Search className="size-4" />
        </Button>
        <form className="relative hidden w-72 items-center md:flex" onSubmit={model.submitSearch}>
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search archive"
            className="pl-8"
            onChange={(event) => model.setSearchDraft(event.target.value)}
            placeholder="Search paths"
            type="search"
            value={model.searchDraft}
          />
        </form>
        <Button
          aria-expanded={model.showDetailPanel}
          aria-label={model.showDetailPanel ? "Hide preview panel" : "Show preview panel"}
          className="hidden shrink-0 lg:inline-flex"
          onClick={() => model.setDetailPanelOpen(!model.showDetailPanel)}
          size="icon"
          title={model.showDetailPanel ? "Hide preview panel" : "Show preview panel"}
          type="button"
          variant="outline"
        >
          {model.showDetailPanel ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </Button>
      </div>
    </header>
  );
}

function MobilePathHeader(): JSX.Element {
  const model = useGalleryPageModel();
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1">
        <Button
          disabled={!model.parentPath && model.displayPath === ""}
          onClick={() => model.navigateToPath(model.parentPath ?? "")}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronUp className="size-4" />
        </Button>
        <button
          className="min-w-0 flex-1 truncate text-left text-base font-semibold"
          onClick={() => model.setPathSheetOpen(true)}
          type="button"
        >
          {model.currentFolderName}
        </button>
      </div>
      {model.displayPath ? (
        <p className="truncate text-xs text-muted-foreground">{model.displayPath}</p>
      ) : null}
    </div>
  );
}

function DesktopPathHeader(): JSX.Element {
  const model = useGalleryPageModel();
  return (
    <>
      <div className="hidden items-center gap-1 md:flex">
        <Button
          disabled={!model.displayPath}
          onClick={() => model.navigateToPath(model.parentPath ?? "")}
          size="sm"
          type="button"
          variant="outline"
        >
          Parent
        </Button>
        <Button
          onClick={() => model.navigateSiblingFolder(-1)}
          size="sm"
          type="button"
          variant="outline"
        >
          Prev folder
        </Button>
        <Button
          onClick={() => model.navigateSiblingFolder(1)}
          size="sm"
          type="button"
          variant="outline"
        >
          Next folder
        </Button>
      </div>
      <Breadcrumb className="flex min-w-0 items-center gap-2">
        <Archive className="size-4 shrink-0 text-muted-foreground" />
        <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button
                className="max-w-40 min-h-10 cursor-pointer truncate rounded-md px-2 py-1.5"
                onClick={() => model.navigateToPath("")}
                type="button"
              >
                {model.archiveRoot}
              </button>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {model.breadcrumbs.map((crumb, index) => (
            <Fragment key={crumb.path}>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                {index === model.breadcrumbs.length - 1 ? (
                  <BreadcrumbPage className="max-w-72 truncate px-2 py-1.5" title={crumb.path}>
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <button
                      className="max-w-40 min-h-10 cursor-pointer truncate rounded-md px-2 py-1.5"
                      onClick={() => model.navigateToPath(crumb.path)}
                      title={crumb.path}
                      type="button"
                    >
                      {crumb.label}
                    </button>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    </>
  );
}

function GalleryContent(): JSX.Element {
  const model = useGalleryPageModel();
  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {model.isReady ? (
          <GalleryBrowsePane
            columnCountRef={model.columnCountRef}
            comicMode={model.effectiveComicMode}
            deletedEntryIds={model.deletedEntryIds}
            deletingEntryIds={model.deletingEntryIds}
            entries={model.entries}
            focusedEntryIndex={model.focusedEntryIndex}
            isFetching={model.showFetching}
            loadingMoreMedia={model.loadingMoreMedia}
            mediaPage={model.mediaPage}
            onActivateEntry={model.handleActivateEntry}
            onDelete={model.deleteSelectedMedia}
            onLoadMoreMedia={model.handleLoadMoreMedia}
            onNext={() => model.selectAdjacentMedia(1)}
            onOpenViewer={() => {
              if (model.selected && !model.deletedEntryIds.has(model.selected.id))
                model.openViewer(model.navigableMedia, model.selected.id);
            }}
            onPrev={() => model.selectAdjacentMedia(-1)}
            onSelectEntry={model.handleSelectEntry}
            scrollRequestKey={model.scrollRequestKey}
            selected={model.selected}
            selectedId={model.viewerLockedMediaId ?? model.selected?.id ?? null}
            showDetailPanel={model.showDetailPanel}
            paginationResetKey={model.browseKey}
            thumbnailSize={model.settings.thumbnailSize}
          />
        ) : (
          <GalleryGridSkeleton />
        )}
      </div>
      <FloatingToolbar
        comicMode={model.effectiveComicMode}
        currentPath={model.displayPath}
        isRefreshing={model.showFetching}
        onChangeSortMode={model.setSortMode}
        onRefresh={() => void model.invalidateLibrary()}
        onToggleComicMode={() => {
          if (!model.folderModesEnabled) return;
          model.setComicMode(!model.effectiveComicMode);
        }}
        onToggleRecursive={() => {
          if (!model.folderModesEnabled) return;
          model.setRecursive(!model.effectiveRecursive);
        }}
        recursive={model.effectiveRecursive}
        recursiveDisabled={!model.folderModesEnabled}
        shuffle={model.shuffle}
        sortMode={model.sortMode}
      />
    </>
  );
}

function GalleryOverlays(): JSX.Element {
  const model = useGalleryPageModel();
  const viewerMedia = model.viewerItems ?? model.visibleMedia;
  return (
    <>
      <SettingsDrawer
        onClose={() => model.setSettingsOpen(false)}
        onUpdate={model.updateSettings}
        onUpdateRecursiveDefault={model.setRecursive}
        open={model.settingsOpen}
        recursiveDefault={model.effectiveRecursive}
        settings={model.settings}
      />
      {model.hotkeysOpen ? <HotkeyOverlay onClose={() => model.setHotkeysOpen(false)} /> : null}
      <Sheet onOpenChange={model.setMobileSearchOpen} open={model.mobileSearchOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Search archive</SheetTitle>
          </SheetHeader>
          <form className="mt-4 grid gap-3" onSubmit={model.submitSearch}>
            <Input
              aria-label="Search archive"
              autoFocus
              onChange={(event) => model.setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={model.searchDraft}
            />
            <Button type="submit">Search</Button>
          </form>
        </SheetContent>
      </Sheet>
      <Sheet onOpenChange={model.setPathSheetOpen} open={model.pathSheetOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Folder path</SheetTitle>
          </SheetHeader>
          <div className="mt-4 grid gap-2">
            <button
              className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
              onClick={() => {
                model.navigateToPath("");
                model.setPathSheetOpen(false);
              }}
              type="button"
            >
              {model.archiveRoot}
            </button>
            {model.breadcrumbs.map((crumb) => (
              <button
                key={crumb.path}
                className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
                onClick={() => {
                  model.navigateToPath(crumb.path);
                  model.setPathSheetOpen(false);
                }}
                type="button"
              >
                {crumb.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
      {model.viewerOpen && model.selected ? (
        <MediaViewerModal
          autoplayVideos={model.settings.autoplayVideos}
          items={viewerMedia}
          loopNavigation={model.settings.loopNavigation}
          loopVideos={model.settings.loopVideos}
          rememberViewerPosition={model.settings.rememberViewerPosition}
          onClose={model.closeViewer}
          startIndex={Math.max(
            0,
            viewerMedia.findIndex((item) => item.id === model.selected?.id),
          )}
        />
      ) : null}
      {model.activeComic ? (
        <ComicReader
          key={model.activeComic.id}
          comic={model.activeComic}
          onClose={() => model.setActiveComic(null)}
        />
      ) : null}
    </>
  );
}
