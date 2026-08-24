import type { ComicEntry } from "@latch-works/media-domain";
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
import type { GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
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
    excludedChildPaths,
    folderModesEnabled,
    listingRequest,
    navigateToPath,
    path: displayPath,
    pruneExcludedChildren,
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
    toggleExcludedChild,
  } = browse;
  const isMobile = useIsMobile();

  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);
  const [openingComicId, setOpeningComicId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(query ?? "");
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollRequestKey, setScrollRequestKey] = useState(0);
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletedEntryIds, setDeletedEntryIds] = useState<ReadonlySet<string>>(() => new Set());

  const session = useGalleryBrowse({
    excludedMediaIds: deletedEntryIds,
    hydrated,
    listingRequest,
    snapshotRequest,
  });
  const {
    allMedia,
    browseKey,
    contentBrowseKey,
    entries,
    isReady,
    library,
    loadNextPage,
    media: navigableMedia,
    openComic,
    page,
    showFetching,
    showRefreshing,
    snapshotIsCurrent,
    stepEntry,
    stepMedia,
  } = session;

  const { viewerOpen, openViewer, closeViewer } = useGalleryViewerHandoff(selectMedia);

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

  const selected =
    allMedia.find((item) => item.id === selectedId) ?? navigableMedia[0] ?? allMedia[0] ?? null;
  // In comic mode the media sequence is the covers; the selected comic is the
  // one whose cover is selected.
  const selectedComic = useMemo(() => {
    if (!effectiveComicMode || !selected) {
      return null;
    }
    const entry = entries.find(
      (candidate) => candidate.kind === "comic" && candidate.comic.cover.id === selected.id,
    );
    return entry?.kind === "comic" ? entry.comic : null;
  }, [effectiveComicMode, entries, selected]);

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

  // The excludable set is the current path's direct child folders, straight
  // from the snapshot (Plan 054). While searching, the snapshot's folders are
  // search matches rather than children, so nothing is excludable; while the
  // snapshot still shows the folder being left, the list is withheld from the
  // auto-prune (and the button simply reads as having no subfolders).
  const excludableChildFolders = useMemo(
    () =>
      query || !snapshotIsCurrent
        ? []
        : [...(library?.folders ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [library, query, snapshotIsCurrent],
  );
  const childFoldersAreCurrent = !query && snapshotIsCurrent && Boolean(library);
  const handleExcludeDialogOpen = useCallback(() => {
    pruneExcludedChildren(excludableChildFolders.map((folder) => folder.path));
  }, [excludableChildFolders, pruneExcludedChildren]);

  const navigateSiblingFolder = useCallback(
    (offset: -1 | 1) => {
      // Until the snapshot belongs to this browse, its folders describe the
      // folder being left; stepping through them would move along an
      // ordering the user cannot see selected.
      if (!library || !snapshotIsCurrent) {
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
    [displayPath, library, navigateToPath, snapshotIsCurrent],
  );

  // Keep the card visible with a loading affordance; open the reader only
  // once the complete comic has arrived. A second activation hits the cache.
  // Only the latest activation, in the browse it was made from, may open the
  // reader: an earlier or superseded request resolving late is dropped.
  const comicActivationRef = useRef<{ browseKey: string; comicId: string } | null>(null);
  const openComicReader = useCallback(
    (comicId: string) => {
      const activation = { browseKey, comicId };
      comicActivationRef.current = activation;
      setOpeningComicId(comicId);
      void openComic(comicId)
        .then((comic) => {
          if (comicActivationRef.current === activation) {
            setActiveComic(comic);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (comicActivationRef.current === activation) {
            comicActivationRef.current = null;
            setOpeningComicId(null);
          }
        });
    },
    [browseKey, openComic],
  );

  // Leaving the browse cancels a pending activation.
  useEffect(() => {
    if (comicActivationRef.current && comicActivationRef.current.browseKey !== browseKey) {
      comicActivationRef.current = null;
      setOpeningComicId(null);
    }
  }, [browseKey]);

  const handleActivateEntry = useCallback(
    (entry: GalleryBrowseEntry) => {
      if (entry.kind === "folder") {
        navigateToPath(entry.path);
      } else if (entry.kind === "comic") {
        openComicReader(entry.comic.id);
      } else {
        openViewer(entry.media.id);
      }
    },
    [navigateToPath, openComicReader, openViewer],
  );

  const handleLoadMoreMedia = useCallback(() => {
    void loadNextPage().catch(() => undefined);
  }, [loadNextPage]);

  const stepBeyondGrid = useCallback(
    (currentKey: string | null, direction: -1 | 1) =>
      stepEntry(currentKey, direction, settings.loopNavigation),
    [settings.loopNavigation, stepEntry],
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
    onStepBeyondGrid: stepBeyondGrid,
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
    void stepMedia(selected?.id ?? null, offset, settings.loopNavigation).then((nextId) => {
      if (nextId) {
        selectMedia(nextId);
      }
    });
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

  const handleSelectEntry = (entry: GalleryBrowseEntry) => {
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
  // A stale snapshot's root label belongs to the folder being left.
  const archiveRoot = snapshotIsCurrent
    ? (library?.archiveRoot ?? "Synced archive")
    : "Synced archive";
  const currentFolderName = breadcrumbs[breadcrumbs.length - 1]?.label ?? archiveRoot;
  const parentPath = getParentPath(displayPath);

  return {
    activeComic,
    archiveRoot,
    breadcrumbs,
    browseKey,
    childFoldersAreCurrent,
    closeViewer,
    contentBrowseKey,
    columnCountRef,
    currentFolderName,
    deleteSelectedMedia,
    deletedEntryIds,
    deletingEntryIds,
    displayPath,
    effectiveComicMode,
    effectiveRecursive,
    entries,
    excludableChildFolders,
    excludedChildPaths,
    handleExcludeDialogOpen,
    focusedEntryIndex,
    folderModesEnabled,
    handleActivateEntry,
    handleLoadMoreMedia,
    handleSelectEntry,
    hotkeysOpen,
    invalidateLibrary,
    isMobile,
    isReady,
    mobileSearchOpen,
    navigateSiblingFolder,
    navigateToPath,
    navigableMedia,
    openComicReader,
    openingComicId,
    openViewer,
    page,
    parentPath,
    pathSheetOpen,
    scrollRequestKey,
    searchDraft,
    selectAdjacentMedia,
    selected,
    selectedComic,
    selectMedia,
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
    showRefreshing,
    shuffle,
    sortMode,
    stepMedia,
    submitSearch,
    toggleExcludedChild,
    updateSettings,
    viewerOpen,
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
            hasMore={model.page.hasMore}
            isFetching={model.showFetching}
            loadingMoreMedia={model.page.loading}
            onActivateEntry={model.handleActivateEntry}
            onDelete={model.deleteSelectedMedia}
            onLoadMoreMedia={model.handleLoadMoreMedia}
            onNext={() => model.selectAdjacentMedia(1)}
            onOpenViewer={() => {
              if (model.selectedComic) {
                model.openComicReader(model.selectedComic.id);
              } else if (model.selected && !model.deletedEntryIds.has(model.selected.id)) {
                model.openViewer(model.selected.id);
              }
            }}
            onPrev={() => model.selectAdjacentMedia(-1)}
            onSelectEntry={model.handleSelectEntry}
            openingComicId={model.openingComicId}
            scrollRequestKey={model.scrollRequestKey}
            selected={model.selected}
            selectedId={model.selected?.id ?? null}
            showDelete={!model.effectiveComicMode}
            showDetailPanel={model.showDetailPanel}
            contentKey={model.contentBrowseKey}
            paginationResetKey={model.browseKey}
            thumbnailSize={model.settings.thumbnailSize}
          />
        ) : (
          <GalleryGridSkeleton />
        )}
      </div>
      <FloatingToolbar
        childFolders={model.excludableChildFolders}
        childFoldersAreCurrent={model.childFoldersAreCurrent}
        comicMode={model.effectiveComicMode}
        currentPath={model.displayPath}
        excludedChildPaths={model.excludedChildPaths}
        isRefreshing={model.showRefreshing}
        onChangeSortMode={model.setSortMode}
        onExcludeDialogOpen={model.handleExcludeDialogOpen}
        onRefresh={() => void model.invalidateLibrary()}
        onToggleExcludedChild={model.toggleExcludedChild}
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
          hasMore={model.page.hasMore}
          items={model.navigableMedia}
          loopNavigation={model.settings.loopNavigation}
          loopVideos={model.settings.loopVideos}
          mediaId={model.selected.id}
          onClose={model.closeViewer}
          onSelect={model.selectMedia}
          rememberViewerPosition={model.settings.rememberViewerPosition}
          stepMedia={model.stepMedia}
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
