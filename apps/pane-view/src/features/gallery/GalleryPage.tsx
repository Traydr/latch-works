import {
  type BrowserEntry,
  buildBrowserEntries,
  buildComicEntries,
  type ComicEntry,
  createRandomSeed,
  type GallerySortMode,
  type MediaItem,
  sortComicEntries,
  sortMediaItems,
} from "@latch-works/media-domain";
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
  canUseFolderBrowseModes,
  displayPathFromSearch,
  type GalleryBrowseSearch,
  getParentPath,
  isTextInputTarget,
} from "@/features/gallery/browse-search";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryBrowsePane } from "@/features/gallery/GalleryBrowsePane";
import { GalleryGridSkeleton } from "@/features/gallery/GalleryGridSkeleton";
import { mergeLibraryMedia } from "@/features/gallery/gallery-page-helpers";
import { useGalleryShell } from "@/features/gallery/gallery-shell-context";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { GALLERY_STATE_DEFAULTS, useGalleryState } from "@/features/gallery/useGalleryState";
import { useGalleryViewerHandoff } from "@/features/gallery/useGalleryViewerHandoff";
import { useWindowedThumbnailResolution } from "@/features/gallery/useWindowedThumbnailResolution";
import {
  toLibrarySnapshotRequest,
  useDeleteLibraryEntryMutation,
  useGalleryListingQuery,
  useInvalidateLibrarySnapshot,
  useLibrarySnapshotQuery,
} from "@/features/library/library-queries";
import { getGalleryListing, getLibrarySnapshot } from "@/features/library/library-service";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import {
  resolveRootKey,
  useAppSettings,
  useRootPreferences,
} from "@/features/settings/useAppSettings";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-mobile";
import type { LibraryMediaItem, MediaPage } from "@/server/library/types";

const galleryIndexRoute = getRouteApi("/_gallery/");

export function GalleryPage() {
  const search = galleryIndexRoute.useSearch();
  const navigate = galleryIndexRoute.useNavigate();
  const hydrated = useHydrated();
  const invalidateLibrary = useInvalidateLibrarySnapshot();
  const deleteEntryMutation = useDeleteLibraryEntryMutation();
  const displayPath = displayPathFromSearch(search.path);
  const { setOpenSettingsHandler } = useGalleryShell();

  const persisted = useGalleryState();
  const { isReady: galleryStateReady } = persisted;
  const { settings, updateSettings } = useAppSettings();
  const rootKey = resolveRootKey(displayPath);
  const { savePreferences: saveRootPreferences } = useRootPreferences(rootKey);
  const isMobile = useIsMobile();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [pathSheetOpen, setPathSheetOpen] = useState(false);
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);

  const [recursive, setRecursive] = useState(search.recursive ?? GALLERY_STATE_DEFAULTS.recursive);
  const [comicMode, setComicMode] = useState(search.comic ?? GALLERY_STATE_DEFAULTS.comicMode);
  const [detailPanelOpen, setDetailPanelOpen] = useState(GALLERY_STATE_DEFAULTS.detailPanelOpen);
  const [sortMode, setSortMode] = useState<GallerySortMode>(GALLERY_STATE_DEFAULTS.sortMode);
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(search.media ?? null);
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollFocusedIntoView, setScrollFocusedIntoView] = useState(false);
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletedEntryIds, setDeletedEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [extraMedia, setExtraMedia] = useState<LibraryMediaItem[]>([]);
  const [extraListingEntries, setExtraListingEntries] = useState<BrowserEntry[]>([]);
  const [extraListingMedia, setExtraListingMedia] = useState<LibraryMediaItem[]>([]);
  const [mediaPage, setMediaPage] = useState<MediaPage | null>(null);
  const [listingPage, setListingPage] = useState<MediaPage | null>(null);
  const [listingCursor, setListingCursor] = useState<string | null>(null);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);
  const [hasRestoredGalleryPrefs, setHasRestoredGalleryPrefs] = useState(false);

  const folderModesEnabled = canUseFolderBrowseModes(search.path);
  const effectiveComicMode = folderModesEnabled && comicMode;
  const effectiveRecursive = folderModesEnabled && (recursive || effectiveComicMode);
  const recursiveToggleDisabled = !folderModesEnabled;

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
  const usesServerListing = !effectiveComicMode;
  const { data: library, isFetching } = useLibrarySnapshotQuery(snapshotRequest);
  const {
    data: listing,
    isFetching: isListingFetching,
    isPlaceholderData: isListingPlaceholderData,
  } = useGalleryListingQuery(listingRequest);
  const showFetching = hydrated && (isFetching || (usesServerListing && isListingFetching));

  const listingBrowseKey = useMemo(
    () =>
      [
        listingRequest.path ?? "",
        listingRequest.query ?? "",
        listingRequest.recursive,
        listingRequest.randomSeed,
        listingRequest.showImages,
        listingRequest.showVideos,
        listingRequest.sortMode,
      ].join("|"),
    [listingRequest],
  );

  const browseKey = useMemo(
    () =>
      [
        snapshotRequest.path ?? "",
        snapshotRequest.query ?? "",
        snapshotRequest.recursive,
        snapshotRequest.comicMode,
      ].join("|"),
    [
      snapshotRequest.comicMode,
      snapshotRequest.path,
      snapshotRequest.query,
      snapshotRequest.recursive,
    ],
  );

  const thumbnailResetKey = `${browseKey}|${listingBrowseKey}|${String(usesServerListing)}`;
  const { resolvedThumbnailUrls, resolvedThumbnailTokens, handleWindowedEntriesChange } =
    useWindowedThumbnailResolution(thumbnailResetKey);

  const { viewerOpen, viewerItems, viewerLockedMediaId, openViewer, closeViewer } =
    useGalleryViewerHandoff(setSelectedId);

  const showDetailPanel = !isMobile && detailPanelOpen;

  const buildBrowseSearch = useCallback(
    (patch: {
      comic?: boolean;
      media?: string;
      path?: string;
      q?: string;
      recursive?: boolean;
    }): GalleryBrowseSearch => {
      const nextPath = patch.path ?? displayPath;
      const nextFolderModesEnabled = canUseFolderBrowseModes(nextPath);

      return {
        comic: nextFolderModesEnabled ? (patch.comic ?? comicMode) || undefined : undefined,
        media: patch.media,
        path: nextPath,
        q: patch.q ?? search.q,
        recursive: nextFolderModesEnabled ? (patch.recursive ?? recursive) || undefined : undefined,
      };
    },
    [comicMode, displayPath, recursive, search.q],
  );

  useEffect(() => {
    setOpenSettingsHandler(() => setSettingsOpen(true));
    return () => setOpenSettingsHandler(null);
  }, [setOpenSettingsHandler]);

  // Redirect to persisted path on first visit if URL has no path.
  useEffect(() => {
    if (!search.path && persisted.lastPath) {
      void navigate({
        search: buildBrowseSearch({
          media: undefined,
          path: persisted.lastPath,
        }),
        to: "/",
      });
    }
  }, []);

  useEffect(() => {
    setSearchDraft(search.q ?? "");
  }, [search.q]);

  useEffect(() => {
    setExtraMedia([]);
    setExtraListingEntries([]);
    setExtraListingMedia([]);
    setMediaPage(null);
    setListingPage(null);
    setListingCursor(null);
    setLoadingMoreMedia(false);
  }, [browseKey, listingBrowseKey, usesServerListing]);

  useEffect(() => {
    if (!library || usesServerListing) {
      return;
    }

    setMediaPage(library.mediaPage);
  }, [browseKey, library, usesServerListing]);

  useEffect(() => {
    if (!listing || !usesServerListing || isListingPlaceholderData) {
      return;
    }

    setListingPage({
      hasMore: listing.page.hasMore,
      limit: listing.page.limit,
      nextOffset: null,
      offset: 0,
    });
    setListingCursor(listing.page.cursor);
  }, [isListingPlaceholderData, listing, listingBrowseKey, usesServerListing]);

  const allMedia = useMemo(() => {
    if (usesServerListing) {
      return mergeLibraryMedia(listing?.media ?? [], extraListingMedia);
    }

    if (!library) {
      return [];
    }

    return mergeLibraryMedia(library.media, extraMedia);
  }, [extraListingMedia, extraMedia, library, listing?.media, usesServerListing]);

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
  }, [allMedia, library, search.media]);

  useEffect(() => {
    if (displayPath === "" && recursive) {
      setRecursive(false);
    }
    if (displayPath === "" && comicMode) {
      setComicMode(false);
    }
  }, [comicMode, displayPath, recursive]);

  const sortedMedia = useMemo(
    () =>
      usesServerListing || allMedia.length === 0
        ? allMedia
        : sortMediaItems(allMedia, sortMode, randomSeed),
    [allMedia, randomSeed, sortMode, usesServerListing],
  );
  const filteredMedia = useMemo(
    () =>
      usesServerListing
        ? sortedMedia
        : sortedMedia.filter((item) => {
            if (item.mediaType === "video" && !settings.showVideos) {
              return false;
            }

            if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
              return false;
            }

            return true;
          }),
    [settings.showImages, settings.showVideos, sortedMedia, usesServerListing],
  );
  const visibleMedia = filteredMedia;
  const navigableMedia = useMemo(
    () => visibleMedia.filter((item) => !deletedEntryIds.has(item.id)),
    [deletedEntryIds, visibleMedia],
  );
  const comics = useMemo(() => {
    if (!effectiveComicMode || !library) {
      return [];
    }

    const groupedComics = buildComicEntries(visibleMedia, displayPath || null, {
      folders: library.allFolders,
      leafFoldersOnly: true,
    });
    return sortComicEntries(groupedComics, sortMode, randomSeed);
  }, [effectiveComicMode, displayPath, library, randomSeed, sortMode, visibleMedia]);
  const clientEntries = useMemo(
    () =>
      library
        ? buildBrowserEntries({
            folders: library.folders,
            comics,
            items: visibleMedia,
            recursive: effectiveRecursive,
            comicMode: effectiveComicMode,
            sortMode,
          })
        : [],
    [comics, effectiveComicMode, effectiveRecursive, library, sortMode, visibleMedia],
  );
  const listingEntries = useMemo(
    () => [...(listing?.entries ?? []), ...extraListingEntries],
    [extraListingEntries, listing?.entries],
  );
  const entries = usesServerListing ? listingEntries : clientEntries;

  useEffect(() => {
    setFocusedEntryIndex((currentIndex) => {
      if (entries.length === 0) {
        return 0;
      }

      return Math.min(currentIndex, entries.length - 1);
    });
  }, [entries]);

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

  useEffect(() => {
    if (!hydrated || !galleryStateReady || hasRestoredGalleryPrefs) {
      return;
    }

    if (search.recursive === undefined) {
      setRecursive(persisted.recursive);
    }

    if (search.comic === undefined) {
      setComicMode(persisted.comicMode);
    }

    setDetailPanelOpen(persisted.detailPanelOpen);
    setSortMode(persisted.sortMode);
    setHasRestoredGalleryPrefs(true);
  }, [
    galleryStateReady,
    hasRestoredGalleryPrefs,
    hydrated,
    persisted.comicMode,
    persisted.detailPanelOpen,
    persisted.recursive,
    persisted.sortMode,
    search.comic,
    search.recursive,
  ]);

  // Persist state changes.
  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setLastPath(displayPath);
  }, [displayPath, hasRestoredGalleryPrefs, hydrated, persisted.setLastPath]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setLastSelectedId(selectedId);
  }, [hasRestoredGalleryPrefs, hydrated, persisted.setLastSelectedId, selectedId]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setRecursive(recursive);
  }, [hasRestoredGalleryPrefs, hydrated, persisted.setRecursive, recursive]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    saveRootPreferences({
      comicMode: effectiveComicMode,
      recursive: effectiveRecursive,
      sortMode,
    });
  }, [
    effectiveComicMode,
    effectiveRecursive,
    hasRestoredGalleryPrefs,
    hydrated,
    saveRootPreferences,
    sortMode,
  ]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setComicMode(comicMode);
  }, [comicMode, hasRestoredGalleryPrefs, hydrated, persisted.setComicMode]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setSortMode(sortMode);
  }, [hasRestoredGalleryPrefs, hydrated, persisted.setSortMode, sortMode]);

  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setDetailPanelOpen(detailPanelOpen);
  }, [detailPanelOpen, hasRestoredGalleryPrefs, hydrated, persisted.setDetailPanelOpen]);

  useEffect(() => {
    const urlRecursive = search.recursive ?? false;
    const urlComic = search.comic ?? false;
    const nextRecursive = folderModesEnabled ? recursive : false;
    const nextComic = folderModesEnabled ? comicMode : false;

    if (urlRecursive === nextRecursive && urlComic === nextComic) {
      return;
    }

    void navigate({
      search: buildBrowseSearch({}),
      to: "/",
      replace: true,
      resetScroll: false,
    });
  }, [
    buildBrowseSearch,
    comicMode,
    folderModesEnabled,
    navigate,
    recursive,
    search.comic,
    search.recursive,
  ]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen || hotkeysOpen || mobileSearchOpen || pathSheetOpen) {
        if (event.key === "Escape") {
          setSettingsOpen(false);
          setHotkeysOpen(false);
          setMobileSearchOpen(false);
          setPathSheetOpen(false);
        }
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        setHotkeysOpen(true);
        return;
      }

      if (viewerOpen) {
        handleViewerKeyDown(event);
        return;
      }

      handleGalleryKeyDown(event);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (viewerOpen) {
        handleViewerKeyUp(event);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  });

  const handleGalleryKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    // Folder navigation with Shift (check before plain WASD).
    if (event.shiftKey) {
      if (key === "w") {
        event.preventDefault();
        const parent = getParentPath(displayPath);
        navigateToPath(parent ?? "");
        return;
      }
      if (key === "s") {
        event.preventDefault();
        const entry = entries[focusedEntryIndex];
        if (entry?.kind === "folder") {
          navigateToPath(entry.path);
        }
        return;
      }
      if (key === "a") {
        event.preventDefault();
        navigateSiblingFolder(-1);
        return;
      }
      if (key === "d") {
        event.preventDefault();
        navigateSiblingFolder(1);
        return;
      }
    }

    // Navigation.
    if (key === "ArrowRight" || key === "d") {
      event.preventDefault();
      moveGridFocus(1, 0);
      return;
    }
    if (key === "ArrowLeft" || key === "a") {
      event.preventDefault();
      moveGridFocus(-1, 0);
      return;
    }
    if (key === "ArrowDown" || key === "s") {
      event.preventDefault();
      moveGridFocus(0, 1);
      return;
    }
    if (key === "ArrowUp" || key === "w") {
      event.preventDefault();
      moveGridFocus(0, -1);
      return;
    }

    // Activate.
    if (key === "Enter" || key === "f") {
      event.preventDefault();
      const entry = entries[focusedEntryIndex];
      if (entry) {
        handleActivateEntry(entry);
      }
      return;
    }
  };

  const handleViewerKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (key === "Escape") {
      event.preventDefault();
      closeViewer();
      return;
    }
    if (key === "ArrowRight" || key === "e") {
      event.preventDefault();
      if (!viewerLockedMediaId) {
        selectAdjacentMedia(1);
      }
      return;
    }
    if (key === "ArrowLeft" || key === "q") {
      event.preventDefault();
      if (!viewerLockedMediaId) {
        selectAdjacentMedia(-1);
      }
      return;
    }
    if (key === " " || key === "2") {
      event.preventDefault();
      // Play/pause handled inside MediaViewerModal.
      return;
    }
    if (key === "1") {
      event.preventDefault();
      // Seek backward handled inside MediaViewerModal.
      return;
    }
    if (key === "3") {
      event.preventDefault();
      // Seek forward handled inside MediaViewerModal.
      return;
    }
    if (key === "4") {
      event.preventDefault();
      // Temporary speed boost handled inside MediaViewerModal.
      return;
    }
  };

  const handleViewerKeyUp = (event: KeyboardEvent) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === "4") {
      // Release speed boost handled inside MediaViewerModal.
    }
  };

  const columnCountRef = useRef(4);

  const moveGridFocus = (dx: number, dy: number) => {
    if (!entries.length) {
      return;
    }

    const columnCount = columnCountRef.current;
    const currentRow = Math.floor(focusedEntryIndex / columnCount);
    const currentCol = focusedEntryIndex % columnCount;

    const nextRow = currentRow + dy;
    const nextCol = currentCol + dx;
    const nextIndex = nextRow * columnCount + nextCol;

    if (nextIndex < 0 || nextIndex >= entries.length) {
      if (entries.length === 0) {
        return;
      }

      const wrappedIndex =
        nextIndex < 0 ? entries.length - 1 : nextIndex >= entries.length ? 0 : nextIndex;
      setFocusedEntryIndex(wrappedIndex);
      setScrollFocusedIntoView(true);
      const wrappedEntry = entries[wrappedIndex];
      if (wrappedEntry?.kind === "media") {
        selectMedia(wrappedEntry.media.id);
      } else if (wrappedEntry?.kind === "comic") {
        selectMedia(wrappedEntry.comic.cover.id);
      }
      return;
    }

    if (nextIndex >= 0 && nextIndex < entries.length) {
      setFocusedEntryIndex(nextIndex);
      setScrollFocusedIntoView(true);
      const entry = entries[nextIndex];
      if (entry?.kind === "media") {
        selectMedia(entry.media.id);
      } else if (entry?.kind === "comic") {
        selectMedia(entry.comic.cover.id);
      }
    }
  };

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
    [buildBrowseSearch, navigate, recursive],
  );

  const navigateSiblingFolder = (offset: -1 | 1) => {
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
  };

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

  const selectMedia = (mediaId: string) => {
    setSelectedId(mediaId);
    void navigate({
      search: buildBrowseSearch({
        media: mediaId,
      }),
      to: "/",
      replace: true,
      resetScroll: false,
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

  const shuffle = () => {
    setSortMode("random");
    setRandomSeed(createRandomSeed());
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

  const handleActivateEntry = (entry: BrowserEntry) => {
    if (entry.kind === "folder") {
      navigateToPath(entry.path);
    } else if (entry.kind === "comic") {
      setActiveComic(entry.comic);
    } else {
      openViewer(visibleMedia, entry.media.id);
    }
  };

  const breadcrumbs = useMemo(() => buildBreadcrumbItems(displayPath), [displayPath]);
  const archiveRoot = library?.archiveRoot ?? "Synced archive";
  const currentFolderName = breadcrumbs[breadcrumbs.length - 1]?.label ?? archiveRoot;
  const parentPath = getParentPath(displayPath);

  const loadMoreMedia = useCallback(async () => {
    if (usesServerListing) {
      if (!listingPage?.hasMore || !listingCursor || loadingMoreMedia) {
        return;
      }

      setLoadingMoreMedia(true);
      try {
        const nextListing = await getGalleryListing({
          data: {
            ...listingRequest,
            cursor: listingCursor,
          },
        });
        setExtraListingMedia((current) => mergeLibraryMedia(current, nextListing.media));
        setExtraListingEntries((current) => [...current, ...nextListing.entries]);
        setListingPage({
          hasMore: nextListing.page.hasMore,
          limit: nextListing.page.limit,
          nextOffset: null,
          offset: 0,
        });
        setListingCursor(nextListing.page.cursor);
      } finally {
        setLoadingMoreMedia(false);
      }
      return;
    }

    if (!mediaPage?.hasMore || mediaPage.nextOffset === null || loadingMoreMedia) {
      return;
    }

    setLoadingMoreMedia(true);
    try {
      const nextSnapshot = await getLibrarySnapshot({
        data: {
          comicMode: snapshotRequest.comicMode,
          mediaOffset: mediaPage.nextOffset,
          path: snapshotRequest.path,
          query: snapshotRequest.query,
          recursive: snapshotRequest.recursive,
        },
      });
      setExtraMedia((current) => mergeLibraryMedia(current, nextSnapshot.media));
      setMediaPage(nextSnapshot.mediaPage);
    } finally {
      setLoadingMoreMedia(false);
    }
  }, [
    listingCursor,
    listingPage,
    listingRequest,
    loadingMoreMedia,
    mediaPage,
    snapshotRequest,
    usesServerListing,
  ]);

  const handleLoadMoreMedia = useCallback(() => {
    void loadMoreMedia();
  }, [loadMoreMedia]);

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
        {library && (!usesServerListing || listing) ? (
          <GalleryBrowsePane
            columnCountRef={columnCountRef}
            comicMode={effectiveComicMode}
            deletedEntryIds={deletedEntryIds}
            deletingEntryIds={deletingEntryIds}
            entries={entries}
            focusedEntryIndex={focusedEntryIndex}
            isFetching={showFetching}
            loadingMoreMedia={loadingMoreMedia}
            mediaPage={usesServerListing ? listingPage : mediaPage}
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
            resolvedThumbnailTokens={resolvedThumbnailTokens}
            resolvedThumbnailUrls={resolvedThumbnailUrls}
            scrollFocusedIntoView={scrollFocusedIntoView}
            selected={selected}
            selectedId={viewerLockedMediaId ?? selectedId}
            showDetailPanel={showDetailPanel}
            paginationResetKey={usesServerListing ? listingBrowseKey : browseKey}
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
