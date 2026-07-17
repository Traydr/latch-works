import type { BrowserEntry, ComicEntry } from "@latch-works/media-domain";
import { getRouteApi } from "@tanstack/react-router";
import { Archive, ChevronUp, PanelRightClose, PanelRightOpen, Search } from "lucide-react";
import { type FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  buildBreadcrumbItems,
  displayPathFromSearch,
  getParentPath,
} from "@/features/gallery/browse-search";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryBrowsePane } from "@/features/gallery/GalleryBrowsePane";
import { GalleryGridSkeleton } from "@/features/gallery/GalleryGridSkeleton";
import { useGalleryShell } from "@/features/gallery/gallery-shell-context";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { useGalleryBrowse } from "@/features/gallery/useGalleryBrowse";
import { useGalleryKeyboard } from "@/features/gallery/useGalleryKeyboard";
import { useGalleryPreferences } from "@/features/gallery/useGalleryPreferences";
import { useGalleryViewerHandoff } from "@/features/gallery/useGalleryViewerHandoff";
import { useWindowedThumbnailResolution } from "@/features/gallery/useWindowedThumbnailResolution";
import {
  toLibrarySnapshotRequest,
  useDeleteLibraryEntryMutation,
  useInvalidateLibrarySnapshot,
} from "@/features/library/library-queries";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import { useAppSettings } from "@/features/settings/useAppSettings";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-mobile";

const galleryIndexRoute = getRouteApi("/_gallery/");

export function GalleryPage() {
  const search = galleryIndexRoute.useSearch();
  const navigate = galleryIndexRoute.useNavigate();
  const hydrated = useHydrated();
  const invalidateLibrary = useInvalidateLibrarySnapshot();
  const deleteEntryMutation = useDeleteLibraryEntryMutation();
  const displayPath = displayPathFromSearch(search.path);
  const { setOpenSettingsHandler } = useGalleryShell();

  const { settings, updateSettings } = useAppSettings();
  const isMobile = useIsMobile();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollFocusedIntoView, setScrollFocusedIntoView] = useState(false);
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletedEntryIds, setDeletedEntryIds] = useState<ReadonlySet<string>>(() => new Set());

  const {
    buildBrowseSearch,
    detailPanelOpen,
    effectiveComicMode,
    effectiveRecursive,
    randomSeed,
    recursive,
    recursiveToggleDisabled,
    selectedId,
    setComicMode,
    setDetailPanelOpen,
    setRecursive,
    setSelectedId,
    setSortMode,
    shuffle,
    sortMode,
  } = useGalleryPreferences({
    displayPath,
    hydrated,
    navigate,
    search,
  });

  const snapshotRequest = useMemo(
    () => ({
      ...toLibrarySnapshotRequest(search),
      comicMode: effectiveComicMode,
      recursive: effectiveRecursive,
      mediaLimit: effectiveComicMode ? undefined : 0,
    }),
    [effectiveComicMode, effectiveRecursive, search],
  );
  const listingRequest = useMemo(
    () => ({
      comicMode: effectiveComicMode,
      path: search.path,
      query: search.q,
      recursive: effectiveRecursive,
      randomSeed,
      showImages: settings.showImages,
      showVideos: settings.showVideos,
      sortMode,
    }),
    [
      effectiveComicMode,
      effectiveRecursive,
      randomSeed,
      search.path,
      search.q,
      settings.showImages,
      settings.showVideos,
      sortMode,
    ],
  );

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

  const { resolvedThumbnailUrls, handleWindowedEntriesChange } =
    useWindowedThumbnailResolution(browseKey);

  const { viewerOpen, viewerItems, viewerLockedMediaId, openViewer, closeViewer } =
    useGalleryViewerHandoff(setSelectedId);

  const showDetailPanel = !isMobile && detailPanelOpen;
  const columnCountRef = useRef(4);

  useEffect(() => {
    setOpenSettingsHandler(() => setSettingsOpen(true));
    return () => setOpenSettingsHandler(null);
  }, [setOpenSettingsHandler]);

  useEffect(() => {
    setSearchDraft(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    if (!library) {
      return;
    }

    const selectedFromSearch = search.media
      ? allMedia.find((item) => item.id === search.media)
      : null;
    const nextSelectedId = selectedFromSearch?.id ?? allMedia[0]?.id ?? null;

    setSelectedId((currentId) => {
      if (!search.media && currentId && allMedia.some((item) => item.id === currentId)) {
        return currentId;
      }

      return nextSelectedId;
    });
  }, [allMedia, library, search.media, setSelectedId]);

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

  const navigateToPath = useCallback(
    (path: string) => {
      const nextRecursive = path === "" ? false : recursive;
      if (path === "" && recursive) {
        setRecursive(false);
      }

      void navigate({
        search: buildBrowseSearch({
          media: undefined,
          path,
          recursive: nextRecursive,
        }),
        to: "/",
      });
    },
    [buildBrowseSearch, navigate, recursive, setRecursive],
  );

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

  const selectMedia = useCallback(
    (mediaId: string) => {
      setSelectedId(mediaId);
      void navigate({
        search: buildBrowseSearch({
          media: mediaId,
        }),
        to: "/",
        replace: true,
        resetScroll: false,
      });
    },
    [buildBrowseSearch, navigate, setSelectedId],
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
  }, []);

  const openHotkeys = useCallback(() => {
    setHotkeysOpen(true);
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
    setScrollFocusedIntoView,
    settingsOpen,
    viewerOpen,
  });

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextQuery = searchDraft.trim();
    void navigate({
      search: buildBrowseSearch({
        media: undefined,
        path: displayPath,
        q: nextQuery || undefined,
      }),
      to: "/",
    });
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

  return (
    <>
      <header className="flex h-auto min-h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-5 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <SidebarTrigger className="-ml-1 shrink-0" />
          {isMobile ? (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <Button
                  disabled={!parentPath && displayPath === ""}
                  onClick={() => navigateToPath(parentPath ?? "")}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <ChevronUp className="size-4" />
                </Button>
                <button
                  className="min-w-0 flex-1 truncate text-left text-base font-semibold"
                  onClick={() => setPathSheetOpen(true)}
                  type="button"
                >
                  {currentFolderName}
                </button>
              </div>
              {displayPath ? (
                <p className="truncate text-xs text-muted-foreground">{displayPath}</p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="hidden items-center gap-1 md:flex">
                <Button
                  disabled={!displayPath}
                  onClick={() => navigateToPath(parentPath ?? "")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Parent
                </Button>
                <Button
                  onClick={() => navigateSiblingFolder(-1)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Prev folder
                </Button>
                <Button
                  onClick={() => navigateSiblingFolder(1)}
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
                        onClick={() => navigateToPath("")}
                        type="button"
                      >
                        {archiveRoot}
                      </button>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  {breadcrumbs.map((crumb, index) => (
                    <Fragment key={crumb.path}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem className="min-w-0">
                        {index === breadcrumbs.length - 1 ? (
                          <BreadcrumbPage
                            className="max-w-72 truncate px-2 py-1.5"
                            title={crumb.path}
                          >
                            {crumb.label}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <button
                              className="max-w-40 min-h-10 cursor-pointer truncate rounded-md px-2 py-1.5"
                              onClick={() => navigateToPath(crumb.path)}
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
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            className="md:hidden"
            onClick={() => setMobileSearchOpen(true)}
            size="icon"
            type="button"
            variant="outline"
          >
            <Search className="size-4" />
          </Button>
          <form className="relative hidden w-72 items-center md:flex" onSubmit={submitSearch}>
            <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Search archive"
              className="pl-8"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
          </form>
          <Button
            aria-expanded={showDetailPanel}
            aria-label={showDetailPanel ? "Hide preview panel" : "Show preview panel"}
            className="hidden shrink-0 lg:inline-flex"
            onClick={() => setDetailPanelOpen((open) => !open)}
            size="icon"
            title={showDetailPanel ? "Hide preview panel" : "Show preview panel"}
            type="button"
            variant="outline"
          >
            {showDetailPanel ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {isReady ? (
          <GalleryBrowsePane
            columnCountRef={columnCountRef}
            comicMode={effectiveComicMode}
            deletedEntryIds={deletedEntryIds}
            deletingEntryIds={deletingEntryIds}
            entries={entries}
            focusedEntryIndex={focusedEntryIndex}
            isFetching={showFetching}
            loadingMoreMedia={loadingMoreMedia}
            mediaPage={mediaPage}
            onActivateEntry={handleActivateEntry}
            onDelete={deleteSelectedMedia}
            onLoadMoreMedia={handleLoadMoreMedia}
            onNext={() => selectAdjacentMedia(1)}
            onOpenViewer={() => {
              if (selected && !deletedEntryIds.has(selected.id)) {
                openViewer(navigableMedia, selected.id);
              }
            }}
            onPrev={() => selectAdjacentMedia(-1)}
            onScrolledToFocus={() => setScrollFocusedIntoView(false)}
            onSelectEntry={handleSelectEntry}
            onWindowedEntriesChange={handleWindowedEntriesChange}
            resolvedThumbnailUrls={resolvedThumbnailUrls}
            scrollFocusedIntoView={scrollFocusedIntoView}
            selected={selected}
            selectedId={viewerLockedMediaId ?? selectedId}
            showDetailPanel={showDetailPanel}
            paginationResetKey={browseKey}
            thumbnailSize={settings.thumbnailSize}
          />
        ) : (
          <GalleryGridSkeleton />
        )}
      </div>

      <FloatingToolbar
        comicMode={effectiveComicMode}
        currentPath={displayPath}
        isRefreshing={showFetching}
        onChangeSortMode={setSortMode}
        onRefresh={() => void invalidateLibrary()}
        onToggleComicMode={() => {
          if (displayPath === "") {
            return;
          }

          setComicMode((current) => {
            const next = !current;
            if (next) {
              setRecursive(true);
            } else {
              setRecursive(false);
            }
            return next;
          });
        }}
        onToggleRecursive={() => {
          if (displayPath === "") {
            return;
          }

          setRecursive((current) => {
            const next = !current;
            if (!next) {
              setComicMode(false);
            }
            return next;
          });
        }}
        recursive={effectiveRecursive}
        recursiveDisabled={recursiveToggleDisabled}
        shuffle={shuffle}
        sortMode={sortMode}
      />

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        onUpdate={updateSettings}
        onUpdateRecursiveDefault={setRecursive}
        open={settingsOpen}
        recursiveDefault={effectiveRecursive}
        settings={settings}
      />

      {hotkeysOpen ? <HotkeyOverlay onClose={() => setHotkeysOpen(false)} /> : null}

      <Sheet onOpenChange={setMobileSearchOpen} open={mobileSearchOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Search archive</SheetTitle>
          </SheetHeader>
          <form className="mt-4 grid gap-3" onSubmit={submitSearch}>
            <Input
              aria-label="Search archive"
              autoFocus
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
            <Button type="submit">Search</Button>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet onOpenChange={setPathSheetOpen} open={pathSheetOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Folder path</SheetTitle>
          </SheetHeader>
          <div className="mt-4 grid gap-2">
            <button
              className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
              onClick={() => {
                navigateToPath("");
                setPathSheetOpen(false);
              }}
              type="button"
            >
              {archiveRoot}
            </button>
            {breadcrumbs.map((crumb) => (
              <button
                key={crumb.path}
                className="min-h-10 rounded-lg border border-border px-3 py-2 text-left text-sm"
                onClick={() => {
                  navigateToPath(crumb.path);
                  setPathSheetOpen(false);
                }}
                type="button"
              >
                {crumb.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {viewerOpen && selected ? (
        <MediaViewerModal
          autoplayVideos={settings.autoplayVideos}
          items={viewerItems ?? visibleMedia}
          loopNavigation={settings.loopNavigation}
          loopVideos={settings.loopVideos}
          rememberViewerPosition={settings.rememberViewerPosition}
          onClose={closeViewer}
          startIndex={Math.max(
            0,
            (viewerItems ?? visibleMedia).findIndex((item) => item.id === selected.id),
          )}
        />
      ) : null}

      {activeComic ? (
        <ComicReader comic={activeComic} onClose={() => setActiveComic(null)} />
      ) : null}
    </>
  );
}
