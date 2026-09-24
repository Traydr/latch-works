import { type FormEvent, type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryBrowsePane } from "@/features/gallery/GalleryBrowsePane";
import { GalleryGridSkeleton } from "@/features/gallery/GalleryGridSkeleton";
import { GalleryHeader } from "@/features/gallery/GalleryHeader";
import { GalleryOverlays } from "@/features/gallery/GalleryOverlays";
import { entryMedia, type GalleryBrowseEntry } from "@/features/gallery/gallery-browse-entry";
import { useGalleryLayout } from "@/features/gallery/gallery-layout-context";
import { useComicActivation } from "@/features/gallery/useComicActivation";
import { useFolderNeighbours } from "@/features/gallery/useFolderNeighbours";
import { useGalleryBrowse } from "@/features/gallery/useGalleryBrowse";
import { useGalleryKeyboard } from "@/features/gallery/useGalleryKeyboard";
import { useGalleryViewerHandoff } from "@/features/gallery/useGalleryViewerHandoff";
import { useDeletedMediaIds, useMediaDeletion } from "@/features/gallery/useMediaDeletion";
import { useInvalidateLibrarySnapshot } from "@/features/library/library-queries";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-mobile";

export function GalleryPage(): JSX.Element {
  const hydrated = useHydrated();
  const invalidateLibrary = useInvalidateLibrarySnapshot();
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
    setRecursive,
    snapshotRequest,
  } = browse;

  const isMobile = useIsMobile();

  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(query ?? "");
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollRequestKey, setScrollRequestKey] = useState(0);
  const deletedMedia = useDeletedMediaIds();

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
  } = useGalleryBrowse({
    excludedMediaIds: deletedMedia.ids,
    hydrated,
    listingRequest,
    snapshotRequest,
  });

  // Grid focus follows a selection made outside the grid keys (the viewer
  // stepping, the detail panel's Prev/Next) once its entry has rendered: a
  // step may have loaded the page the entry is on.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const pendingFocusMediaIdRef = useRef<string | null>(null);

  const focusMediaEntry = useCallback((mediaId: string): boolean => {
    const index = entriesRef.current.findIndex((entry) => entryMedia(entry)?.id === mediaId);

    if (index < 0) {
      return false;
    }

    pendingFocusMediaIdRef.current = null;
    setFocusedEntryIndex(index);

    return true;
  }, []);

  const selectMediaAndFocus = useCallback(
    (mediaId: string) => {
      if (!focusMediaEntry(mediaId)) {
        pendingFocusMediaIdRef.current = mediaId;
      }

      selectMedia(mediaId);
    },
    [focusMediaEntry, selectMedia],
  );

  useEffect(() => {
    if (pendingFocusMediaIdRef.current) {
      focusMediaEntry(pendingFocusMediaIdRef.current);
    }
  }, [entries, focusMediaEntry]);

  // A new folder or search starts on its first entry. Sorting, shuffling, and
  // mode toggles keep the scroll position, so they keep the focus index too.
  useEffect(() => {
    pendingFocusMediaIdRef.current = null;
    setFocusedEntryIndex(0);
  }, [displayPath, query]);

  const { viewerOpen, openViewer, closeViewer } = useGalleryViewerHandoff(selectMediaAndFocus);

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

  const deletion = useMediaDeletion({
    allMedia,
    browseKey,
    deletedMedia,
    library,
    navigableMedia,
    onSelectNeighbour: selectMediaAndFocus,
    selected,
  });

  const folders = useFolderNeighbours({ browse, library, snapshotIsCurrent });
  const comics = useComicActivation(browseKey, openComic);
  const { openComicReader } = comics;

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
    hasMore: page.hasMore,
    hotkeysOpen,
    mobileSearchOpen,
    onActivateEntry: handleActivateEntry,
    onCloseOverlays: closeOverlays,
    onLoadNextPage: loadNextPage,
    onNavigateSiblingFolder: folders.navigateSiblingFolder,
    onNavigateToPath: navigateToPath,
    onOpenHotkeys: openHotkeys,
    onSelectMedia: selectMedia,
    onStepBeyondGrid: stepBeyondGrid,
    pathSheetOpen,
    readerOpen: comics.activeComic !== null,
    setFocusedEntryIndex,
    requestScrollFocusedIntoView,
    settingsOpen,
    viewerOpen,
  });

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    browse.submitSearch(searchDraft);
  };

  const selectedMediaId = selected?.id ?? null;

  const selectAdjacentMedia = useCallback(
    (offset: -1 | 1) => {
      void stepMedia(selectedMediaId, offset, settings.loopNavigation).then((nextId) => {
        if (nextId) {
          selectMediaAndFocus(nextId);
        }
      });
    },
    [selectMediaAndFocus, selectedMediaId, settings.loopNavigation, stepMedia],
  );

  const selectNextMedia = useCallback(() => selectAdjacentMedia(1), [selectAdjacentMedia]);
  const selectPreviousMedia = useCallback(() => selectAdjacentMedia(-1), [selectAdjacentMedia]);
  const deletedEntryIds = deletedMedia.ids;

  const openSelectedInViewer = useCallback(() => {
    if (selectedComic) {
      openComicReader(selectedComic.id);
    } else if (selected && !deletedEntryIds.has(selected.id)) {
      openViewer(selected.id);
    }
  }, [deletedEntryIds, openComicReader, openViewer, selected, selectedComic]);

  const handleSelectEntry = useCallback(
    (entry: GalleryBrowseEntry) => {
      const entryIndex = entriesRef.current.findIndex((candidate) => candidate.key === entry.key);

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
    },
    [navigateToPath, selectMedia],
  );

  const openMobileSearch = useCallback(() => setMobileSearchOpen(true), []);
  const closeHotkeys = useCallback(() => setHotkeysOpen(false), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  // A stale snapshot's root label belongs to the folder being left.
  const archiveRoot = snapshotIsCurrent
    ? (library?.archiveRoot ?? "Synced archive")
    : "Synced archive";

  return (
    <>
      <GalleryHeader
        archiveRoot={archiveRoot}
        canNavigateSiblings={folders.canNavigateSiblings}
        displayPath={displayPath}
        isMobile={isMobile}
        onDetailPanelOpenChange={browse.setDetailPanelOpen}
        onNavigateSiblingFolder={folders.navigateSiblingFolder}
        onNavigateToPath={navigateToPath}
        onOpenMobileSearch={openMobileSearch}
        onPathSheetOpenChange={setPathSheetOpen}
        onSearchDraftChange={setSearchDraft}
        onSubmitSearch={submitSearch}
        pathSheetOpen={pathSheetOpen}
        searchDraft={searchDraft}
        showDetailPanel={showDetailPanel}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {isReady ? (
          <GalleryBrowsePane
            columnCountRef={columnCountRef}
            comicMode={effectiveComicMode}
            deleteError={deletion.selectedDeleteError}
            deletedEntryIds={deletedEntryIds}
            deletingEntryIds={deletion.deletingEntryIds}
            entries={entries}
            focusedEntryIndex={focusedEntryIndex}
            hasMore={page.hasMore}
            isFetching={showFetching}
            isMobile={isMobile}
            loadingMoreMedia={page.loading}
            onActivateEntry={handleActivateEntry}
            onDelete={deletion.deleteSelectedMedia}
            onLoadMoreMedia={handleLoadMoreMedia}
            onNext={selectNextMedia}
            onOpenViewer={openSelectedInViewer}
            onPrev={selectPreviousMedia}
            onSelectEntry={handleSelectEntry}
            openingComicId={comics.openingComicId}
            scrollRequestKey={scrollRequestKey}
            selected={selected}
            selectedId={selected?.id ?? null}
            showDelete={!effectiveComicMode}
            showDetailPanel={showDetailPanel}
            contentKey={contentBrowseKey}
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
        exclude={folders.exclude}
        isRefreshing={showRefreshing}
        onChangeSortMode={browse.setSortMode}
        onRefresh={() => void invalidateLibrary()}
        onToggleComicMode={() => {
          if (!folderModesEnabled) return;
          setComicMode(!effectiveComicMode);
        }}
        onToggleRecursive={() => {
          if (!folderModesEnabled) return;
          setRecursive(!effectiveRecursive);
        }}
        recursive={effectiveRecursive}
        recursiveDisabled={!folderModesEnabled}
        shuffle={browse.shuffle}
        sortMode={browse.sortMode}
      />
      <GalleryOverlays
        activeComic={comics.activeComic}
        hotkeysOpen={hotkeysOpen}
        mobileSearchOpen={mobileSearchOpen}
        onCloseComicReader={comics.closeComicReader}
        onCloseHotkeys={closeHotkeys}
        onCloseSettings={closeSettings}
        onMobileSearchOpenChange={setMobileSearchOpen}
        onSearchDraftChange={setSearchDraft}
        onSubmitSearch={submitSearch}
        onUpdateRecursiveDefault={setRecursive}
        onUpdateSettings={updateSettings}
        recursiveDefault={browse.rememberedRecursive}
        searchDraft={searchDraft}
        settings={settings}
        settingsOpen={settingsOpen}
        viewer={
          viewerOpen && selected
            ? {
                hasMore: page.hasMore,
                items: navigableMedia,
                mediaId: selected.id,
                onClose: closeViewer,
                onSelect: selectMediaAndFocus,
                stepMedia,
              }
            : null
        }
      />
    </>
  );
}
