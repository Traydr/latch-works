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
import {
  type FormEvent,
  Fragment,
  type MutableRefObject,
  Suspense,
  useCallback,
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
import { BrowserGrid } from "@/features/gallery/BrowserGrid";
import {
  type GalleryThumbnailRequest,
  readCachedGalleryThumbnailUrls,
  resolveGalleryThumbnailsBatch,
} from "@/features/gallery/batched-thumbnail-resolver";
import {
  buildBreadcrumbItems,
  displayPathFromSearch,
  type GalleryBrowseSearch,
  getParentPath,
  isTextInputTarget,
} from "@/features/gallery/browse-search";
import { DetailPanel } from "@/features/gallery/DetailPanel";
import { FloatingToolbar } from "@/features/gallery/FloatingToolbar";
import { GalleryGridSkeleton } from "@/features/gallery/GalleryGridSkeleton";
import { useGalleryShell } from "@/features/gallery/gallery-shell-context";
import { MediaViewerModal } from "@/features/gallery/MediaViewerModal";
import { DEFAULT_CARD_WIDTH } from "@/features/gallery/thumbnail-size";
import { GALLERY_STATE_DEFAULTS, useGalleryState } from "@/features/gallery/useGalleryState";
import {
  type LibrarySnapshotRequest,
  toLibrarySnapshotRequest,
  useDeleteLibraryEntryMutation,
  useInvalidateLibrarySnapshot,
  useLibrarySnapshotQuery,
  useLibrarySnapshotSuspense,
} from "@/features/library/library-queries";
import { getLibrarySnapshot } from "@/features/library/library-service";
import { regenerateMediaThumbnail } from "@/features/media/media-delivery-service";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import {
  resolveRootKey,
  useAppSettings,
  useRootPreferences,
} from "@/features/settings/useAppSettings";
import { useHydrated } from "@/hooks/use-hydrated";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { LibraryMediaItem, MediaPage } from "@/server/library/types";

const galleryIndexRoute = getRouteApi("/_gallery/");

export function GalleryPage() {
  const search = galleryIndexRoute.useSearch();
  const navigate = galleryIndexRoute.useNavigate();
  const snapshotRequest = toLibrarySnapshotRequest(search);
  const { data: library, isFetching } = useLibrarySnapshotQuery(snapshotRequest);
  const hydrated = useHydrated();
  const showFetching = hydrated && isFetching;
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
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerItems, setViewerItems] = useState<MediaItem[] | null>(null);
  /** When set, gallery selection stays on this id while the viewer pages through `viewerItems`. */
  const [viewerLockedMediaId, setViewerLockedMediaId] = useState<string | null>(null);
  const [focusedEntryIndex, setFocusedEntryIndex] = useState(0);
  const [scrollFocusedIntoView, setScrollFocusedIntoView] = useState(false);
  const [deletingEntryIds, setDeletingEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletedEntryIds, setDeletedEntryIds] = useState<ReadonlySet<string>>(() => new Set());
  const [extraMedia, setExtraMedia] = useState<LibraryMediaItem[]>([]);
  const [mediaPage, setMediaPage] = useState<MediaPage | null>(null);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);
  const [hasRestoredGalleryPrefs, setHasRestoredGalleryPrefs] = useState(false);
  const [windowedThumbnailRequests, setWindowedThumbnailRequests] = useState<
    GalleryThumbnailRequest[]
  >([]);
  const [resolvedThumbnailUrls, setResolvedThumbnailUrls] = useState<Record<string, string>>({});

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

  const showDetailPanel = !isMobile && detailPanelOpen;

  const buildBrowseSearch = useCallback(
    (patch: {
      comic?: boolean;
      media?: string;
      path?: string;
      q?: string;
      recursive?: boolean;
    }): GalleryBrowseSearch => ({
      comic: (patch.comic ?? comicMode) || undefined,
      media: patch.media,
      path: patch.path ?? displayPath,
      q: patch.q ?? search.q,
      recursive: (patch.recursive ?? recursive) || undefined,
    }),
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
    setMediaPage(null);
    setLoadingMoreMedia(false);
    setWindowedThumbnailRequests([]);
    setResolvedThumbnailUrls(readCachedGalleryThumbnailUrls());
  }, [browseKey]);

  useEffect(() => {
    if (!library) {
      return;
    }

    setMediaPage(library.mediaPage);
  }, [browseKey, library]);

  const allMedia = useMemo(() => {
    if (!library) {
      return [];
    }

    return mergeLibraryMedia(library.media, extraMedia);
  }, [extraMedia, library]);

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

  const effectiveRecursive = recursive || comicMode;
  const recursiveToggleDisabled = displayPath === "";

  useEffect(() => {
    if (displayPath === "" && recursive) {
      setRecursive(false);
    }
  }, [displayPath, recursive]);

  const sortedMedia = useMemo(
    () => (allMedia.length > 0 ? sortMediaItems(allMedia, sortMode, randomSeed) : []),
    [allMedia, randomSeed, sortMode],
  );
  const filteredMedia = useMemo(
    () =>
      sortedMedia.filter((item) => {
        if (item.mediaType === "video" && !settings.showVideos) {
          return false;
        }

        if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
          return false;
        }

        return true;
      }),
    [settings.showImages, settings.showVideos, sortedMedia],
  );
  const visibleMedia = filteredMedia;
  const navigableMedia = useMemo(
    () => visibleMedia.filter((item) => !deletedEntryIds.has(item.id)),
    [deletedEntryIds, visibleMedia],
  );
  const comics = useMemo(() => {
    if (!comicMode || !library) {
      return [];
    }

    const groupedComics = buildComicEntries(visibleMedia, displayPath || null, {
      folders: library.allFolders,
      leafFoldersOnly: true,
    });
    return sortComicEntries(groupedComics, sortMode, randomSeed);
  }, [comicMode, displayPath, library, randomSeed, sortMode, visibleMedia]);
  const entries = useMemo(
    () =>
      library
        ? buildBrowserEntries({
            folders: library.folders,
            comics,
            items: visibleMedia,
            recursive: effectiveRecursive,
            comicMode,
            sortMode,
          })
        : [],
    [comicMode, comics, effectiveRecursive, library, sortMode, visibleMedia],
  );

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
      comicMode,
      recursive,
      sortMode,
    });
  }, [comicMode, hasRestoredGalleryPrefs, hydrated, recursive, saveRootPreferences, sortMode]);

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
    if (urlRecursive === recursive && urlComic === comicMode) {
      return;
    }

    void navigate({
      search: buildBrowseSearch({}),
      to: "/",
      replace: true,
      resetScroll: false,
    });
  }, [buildBrowseSearch, comicMode, navigate, recursive, search.comic, search.recursive]);

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

  const openViewer = (
    items: MediaItem[],
    startMediaId: string,
    options?: { lockSelectionToMediaId?: string },
  ) => {
    const startIndex = items.findIndex((item) => item.id === startMediaId);
    if (startIndex < 0) {
      return;
    }

    setViewerItems(items);
    setViewerLockedMediaId(options?.lockSelectionToMediaId ?? null);
    setSelectedId(options?.lockSelectionToMediaId ?? startMediaId);
    setViewerOpen(true);
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setViewerItems(null);
    setViewerLockedMediaId(null);
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
  }, [loadingMoreMedia, mediaPage, snapshotRequest]);

  const handleWindowedEntriesChange = useCallback((windowedEntries: BrowserEntry[]) => {
    const requests = dedupeThumbnailRequests(
      windowedEntries.flatMap((entry): GalleryThumbnailRequest[] => {
        if (entry.kind === "folder") {
          return [];
        }

        const media = entry.kind === "comic" ? entry.comic.cover : entry.media;
        if (!supportsGalleryThumbnail(media) || media.thumbnailUrl) {
          return [];
        }

        return [{ mediaId: media.id }];
      }),
    );

    setWindowedThumbnailRequests((current) =>
      areThumbnailRequestsEqual(current, requests) ? current : requests,
    );
  }, []);

  useEffect(() => {
    if (windowedThumbnailRequests.length === 0) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void resolveGalleryThumbnailsBatch(windowedThumbnailRequests).then((urls) => {
        if (!cancelled) {
          setResolvedThumbnailUrls(urls);
        }
      });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [windowedThumbnailRequests]);

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
                        className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
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
                              className="max-w-40 cursor-pointer truncate rounded-md px-2 py-1.5"
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
        <Suspense fallback={<GalleryGridSkeleton />}>
          <GalleryBrowsePane
            columnCountRef={columnCountRef}
            comicMode={comicMode}
            deletedEntryIds={deletedEntryIds}
            deletingEntryIds={deletingEntryIds}
            displayPath={displayPath}
            effectiveRecursive={effectiveRecursive}
            focusedEntryIndex={focusedEntryIndex}
            isFetching={showFetching}
            loadingMoreMedia={loadingMoreMedia}
            media={allMedia}
            mediaPage={mediaPage}
            onActivateEntry={handleActivateEntry}
            onDelete={deleteSelectedMedia}
            onLoadMoreMedia={() => void loadMoreMedia()}
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
            randomSeed={randomSeed}
            resolvedThumbnailUrls={resolvedThumbnailUrls}
            scrollFocusedIntoView={scrollFocusedIntoView}
            selected={selected}
            selectedId={viewerLockedMediaId ?? selectedId}
            showDetailPanel={showDetailPanel}
            snapshotRequest={snapshotRequest}
            sortMode={sortMode}
            thumbnailSize={settings.thumbnailSize}
          />
        </Suspense>
      </div>

      <FloatingToolbar
        comicMode={comicMode}
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
        recursive={recursive}
        recursiveDisabled={recursiveToggleDisabled}
        shuffle={shuffle}
        sortMode={sortMode}
      />

      <SettingsDrawer
        onClose={() => setSettingsOpen(false)}
        onUpdate={updateSettings}
        onUpdateRecursiveDefault={setRecursive}
        open={settingsOpen}
        recursiveDefault={recursive}
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
              className="rounded-lg border border-border px-3 py-2 text-left text-sm"
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
                className="rounded-lg border border-border px-3 py-2 text-left text-sm"
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

interface GalleryBrowsePaneProps {
  columnCountRef: MutableRefObject<number>;
  comicMode: boolean;
  deletedEntryIds: ReadonlySet<string>;
  deletingEntryIds: ReadonlySet<string>;
  displayPath: string;
  effectiveRecursive: boolean;
  focusedEntryIndex: number;
  isFetching: boolean;
  loadingMoreMedia: boolean;
  media: LibraryMediaItem[];
  mediaPage: MediaPage | null;
  onActivateEntry: (entry: BrowserEntry) => void;
  onDelete: () => void;
  onLoadMoreMedia: () => void;
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  onScrolledToFocus: () => void;
  onSelectEntry: (entry: BrowserEntry) => void;
  onWindowedEntriesChange: (entries: BrowserEntry[]) => void;
  randomSeed: number;
  resolvedThumbnailUrls: Readonly<Record<string, string>>;
  scrollFocusedIntoView: boolean;
  selected: MediaItem | null;
  selectedId: string | null;
  showDetailPanel: boolean;
  snapshotRequest: LibrarySnapshotRequest;
  sortMode: GallerySortMode;
  thumbnailSize: number;
}

function GalleryBrowsePane({
  columnCountRef,
  comicMode,
  deletedEntryIds,
  deletingEntryIds,
  displayPath,
  effectiveRecursive,
  focusedEntryIndex,
  isFetching,
  loadingMoreMedia,
  media,
  mediaPage,
  onActivateEntry,
  onDelete,
  onLoadMoreMedia,
  onNext,
  onOpenViewer,
  onPrev,
  onScrolledToFocus,
  onSelectEntry,
  onWindowedEntriesChange,
  randomSeed,
  resolvedThumbnailUrls,
  scrollFocusedIntoView,
  selected,
  selectedId,
  showDetailPanel,
  snapshotRequest,
  sortMode,
  thumbnailSize,
}: GalleryBrowsePaneProps) {
  const { data: library } = useLibrarySnapshotSuspense(snapshotRequest);
  const { settings } = useAppSettings();
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mediaPage?.hasMore || loadingMoreMedia || !scrollContainer) {
      return;
    }

    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreMedia();
        }
      },
      { root: scrollContainer, rootMargin: "320px 0px 320px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadingMoreMedia, mediaPage?.hasMore, onLoadMoreMedia, scrollContainer]);

  const sortedMedia = useMemo(
    () => sortMediaItems(media, sortMode, randomSeed),
    [media, randomSeed, sortMode],
  );
  const visibleMedia = useMemo(
    () =>
      sortedMedia.filter((item) => {
        if (item.mediaType === "video" && !settings.showVideos) {
          return false;
        }

        if ((item.mediaType === "image" || item.mediaType === "gif") && !settings.showImages) {
          return false;
        }

        return true;
      }),
    [settings.showImages, settings.showVideos, sortedMedia],
  );
  const comics = useMemo(() => {
    if (!comicMode) {
      return [];
    }

    const groupedComics = buildComicEntries(visibleMedia, displayPath || null, {
      folders: library.allFolders,
      leafFoldersOnly: true,
    });
    return sortComicEntries(groupedComics, sortMode, randomSeed);
  }, [comicMode, displayPath, library.allFolders, randomSeed, sortMode, visibleMedia]);
  const entries = useMemo(
    () =>
      buildBrowserEntries({
        folders: library.folders,
        comics,
        items: visibleMedia,
        recursive: effectiveRecursive,
        comicMode,
        sortMode,
      }),
    [comicMode, comics, effectiveRecursive, library.folders, sortMode, visibleMedia],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden",
        isFetching && "opacity-80 transition-opacity",
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <BrowserGrid
          cardWidth={thumbnailSize}
          comicMode={comicMode}
          columnCountRef={columnCountRef}
          deletedEntryIds={deletedEntryIds}
          deletingEntryIds={deletingEntryIds}
          entries={entries}
          focusedIndex={focusedEntryIndex}
          loadMoreSentinelRef={loadMoreSentinelRef}
          onActivateEntry={onActivateEntry}
          onScrollContainerChange={setScrollContainer}
          onScrolledToFocus={onScrolledToFocus}
          onSelectEntry={onSelectEntry}
          onWindowedEntriesChange={onWindowedEntriesChange}
          scrollFocusedIntoView={scrollFocusedIntoView}
          selectedId={selectedId}
          thumbnailUrls={resolvedThumbnailUrls}
        />

        {mediaPage?.hasMore ? (
          <div className="flex shrink-0 justify-center border-t border-border px-5 pb-24 pt-3 sm:pb-20">
            <Button
              disabled={loadingMoreMedia}
              onClick={onLoadMoreMedia}
              size="sm"
              type="button"
              variant="outline"
            >
              {loadingMoreMedia ? "Loading more…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>

      {showDetailPanel ? (
        <div className="hidden min-h-0 min-w-0 max-w-[360px] shrink-0 lg:block">
          <DetailPanel
            isDeleted={selected ? deletedEntryIds.has(selected.id) : false}
            isDeleting={selected ? deletingEntryIds.has(selected.id) : false}
            onCopyPath={() => {
              if (selected) {
                void navigator.clipboard.writeText(selected.path);
              }
            }}
            onDelete={onDelete}
            onDownload={() => {
              if (selected) {
                window.open(`/api/media/${selected.id}/original`, "_blank", "noopener,noreferrer");
              }
            }}
            onNext={onNext}
            onOpenViewer={onOpenViewer}
            onPrev={onPrev}
            onRegenerateThumbnail={async () => {
              if (!selected) {
                return;
              }

              await regenerateMediaThumbnail({
                data: { mediaId: selected.id, size: DEFAULT_CARD_WIDTH },
              });
            }}
            selected={selected}
            showDelete
          />
        </div>
      ) : null}
    </div>
  );
}

function mergeLibraryMedia(
  base: readonly LibraryMediaItem[],
  extra: readonly LibraryMediaItem[],
): LibraryMediaItem[] {
  if (extra.length === 0) {
    return [...base];
  }

  const seen = new Set(base.map((item) => item.id));
  const merged = [...base];
  for (const item of extra) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }

  return merged;
}

function supportsGalleryThumbnail(media: MediaItem): boolean {
  return media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video";
}

function dedupeThumbnailRequests(
  requests: readonly GalleryThumbnailRequest[],
): GalleryThumbnailRequest[] {
  const seen = new Set<string>();
  const deduped: GalleryThumbnailRequest[] = [];

  for (const request of requests) {
    const key = `${request.mediaId}:${request.size ?? "default"}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(request);
  }

  return deduped;
}

function areThumbnailRequestsEqual(
  left: readonly GalleryThumbnailRequest[],
  right: readonly GalleryThumbnailRequest[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (request, index) =>
      request.mediaId === right[index]?.mediaId && request.size === right[index]?.size,
  );
}
