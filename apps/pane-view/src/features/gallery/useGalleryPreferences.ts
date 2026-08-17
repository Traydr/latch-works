import type { GallerySortMode } from "@latch-works/media-domain";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canUseFolderBrowseModes,
  type GalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import { createGalleryRandomSeed } from "@/features/gallery/gallery-random-seed";
import { GALLERY_STATE_DEFAULTS, useGalleryState } from "@/features/gallery/useGalleryState";
import { resolveRootKey, useRootPreferences } from "@/features/settings/useAppSettings";

export interface GalleryPreferences {
  comicMode: boolean;
  detailPanel: boolean;
  path: string;
  recursive: boolean;
  selectedId: string | null;
  sortMode: GallerySortMode;
}

export interface UseGalleryPreferencesOptions {
  displayPath: string;
  hydrated: boolean;
  navigate: (opts: {
    search: GalleryBrowseSearch;
    to: "/";
    replace?: boolean;
    resetScroll?: boolean;
  }) => unknown;
  search: GalleryBrowseSearch;
}

/**
 * Hydrate and persist gallery browse preferences as one object
 * (path, selectedId, recursive, comicMode, sortMode, detailPanel, root prefs).
 */
export function useGalleryPreferences({
  displayPath,
  hydrated,
  navigate,
  search,
}: UseGalleryPreferencesOptions) {
  const persisted = useGalleryState();
  const { isReady: galleryStateReady } = persisted;
  const rootKey = resolveRootKey(displayPath);
  const { savePreferences: saveRootPreferences } = useRootPreferences(rootKey);

  const [recursiveOverride, setRecursiveOverride] = useState<boolean>();
  const [comicModeOverride, setComicModeOverride] = useState<boolean>();
  const [detailPanelOverride, setDetailPanelOverride] = useState<boolean>();
  const [sortModeOverride, setSortModeOverride] = useState<GallerySortMode>();
  const [randomSeed, setRandomSeed] = useState(() => createGalleryRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(search.media ?? null);
  const hasCheckedInitialPathRef = useRef(false);
  const baseRecursive =
    search.recursive ??
    (galleryStateReady ? persisted.recursive : GALLERY_STATE_DEFAULTS.recursive);
  const baseComicMode =
    search.comic ?? (galleryStateReady ? persisted.comicMode : GALLERY_STATE_DEFAULTS.comicMode);
  const baseDetailPanel = galleryStateReady
    ? persisted.detailPanelOpen
    : GALLERY_STATE_DEFAULTS.detailPanelOpen;
  const baseSortMode = galleryStateReady ? persisted.sortMode : GALLERY_STATE_DEFAULTS.sortMode;
  const recursive = recursiveOverride ?? baseRecursive;
  const comicMode = comicModeOverride ?? baseComicMode;
  const detailPanelOpen = detailPanelOverride ?? baseDetailPanel;
  const sortMode = sortModeOverride ?? baseSortMode;
  const hasRestoredGalleryPrefs = hydrated && galleryStateReady;

  const setRecursive: Dispatch<SetStateAction<boolean>> = useCallback(
    (next) => {
      setRecursiveOverride((current) =>
        typeof next === "function" ? next(current ?? baseRecursive) : next,
      );
    },
    [baseRecursive],
  );
  const setComicMode: Dispatch<SetStateAction<boolean>> = useCallback(
    (next) => {
      setComicModeOverride((current) =>
        typeof next === "function" ? next(current ?? baseComicMode) : next,
      );
    },
    [baseComicMode],
  );
  const setDetailPanelOpen: Dispatch<SetStateAction<boolean>> = useCallback(
    (next) => {
      setDetailPanelOverride((current) =>
        typeof next === "function" ? next(current ?? baseDetailPanel) : next,
      );
    },
    [baseDetailPanel],
  );
  const setSortMode: Dispatch<SetStateAction<GallerySortMode>> = useCallback(
    (next) => {
      setSortModeOverride((current) =>
        typeof next === "function" ? next(current ?? baseSortMode) : next,
      );
    },
    [baseSortMode],
  );

  const folderModesEnabled = canUseFolderBrowseModes(search.path);
  const effectiveComicMode = folderModesEnabled && comicMode;
  const effectiveRecursive = folderModesEnabled && (recursive || effectiveComicMode);
  const recursiveToggleDisabled = !folderModesEnabled;

  const preferences = useMemo<GalleryPreferences>(
    () => ({
      comicMode,
      detailPanel: detailPanelOpen,
      path: displayPath,
      recursive,
      selectedId,
      sortMode,
    }),
    [comicMode, detailPanelOpen, displayPath, recursive, selectedId, sortMode],
  );

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

  // Redirect to persisted path on first visit if URL has no path.
  useEffect(() => {
    if (!hydrated || !galleryStateReady || hasCheckedInitialPathRef.current) {
      return;
    }

    hasCheckedInitialPathRef.current = true;
    if (!search.path && persisted.lastPath) {
      void navigate({
        search: buildBrowseSearch({
          media: undefined,
          path: persisted.lastPath,
        }),
        to: "/",
      });
    }
  }, [buildBrowseSearch, galleryStateReady, hydrated, navigate, persisted.lastPath, search.path]);

  // Persist preferences as one object (local + root).
  useEffect(() => {
    if (!hydrated || !hasRestoredGalleryPrefs) {
      return;
    }

    persisted.setPreferences({
      comicMode: preferences.comicMode,
      detailPanelOpen: preferences.detailPanel,
      lastPath: preferences.path,
      lastSelectedId: preferences.selectedId,
      recursive: preferences.recursive,
      sortMode: preferences.sortMode,
    });

    saveRootPreferences({
      comicMode: effectiveComicMode,
      recursive: effectiveRecursive,
      sortMode: preferences.sortMode,
    });
  }, [
    effectiveComicMode,
    effectiveRecursive,
    hasRestoredGalleryPrefs,
    hydrated,
    persisted.setPreferences,
    preferences,
    saveRootPreferences,
  ]);

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

  const shuffle = useCallback(() => {
    setSortMode("random");
    setRandomSeed((current) => createGalleryRandomSeed(current));
  }, [setSortMode]);

  return {
    buildBrowseSearch,
    comicMode,
    detailPanelOpen,
    effectiveComicMode,
    effectiveRecursive,
    folderModesEnabled,
    hasRestoredGalleryPrefs,
    preferences,
    randomSeed,
    recursive,
    recursiveToggleDisabled,
    selectedId,
    setComicMode,
    setDetailPanelOpen,
    setRandomSeed,
    setRecursive,
    setSelectedId,
    setSortMode,
    shuffle,
    sortMode,
  };
}
