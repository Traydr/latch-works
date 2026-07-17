import type { GallerySortMode } from "@latch-works/media-domain";
import { createRandomSeed } from "@latch-works/media-domain";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canUseFolderBrowseModes,
  type GalleryBrowseSearch,
} from "@/features/gallery/browse-search";
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

  const [recursive, setRecursive] = useState(search.recursive ?? GALLERY_STATE_DEFAULTS.recursive);
  const [comicMode, setComicMode] = useState(search.comic ?? GALLERY_STATE_DEFAULTS.comicMode);
  const [detailPanelOpen, setDetailPanelOpen] = useState(GALLERY_STATE_DEFAULTS.detailPanelOpen);
  const [sortMode, setSortMode] = useState<GallerySortMode>(GALLERY_STATE_DEFAULTS.sortMode);
  const [randomSeed, setRandomSeed] = useState(() => createRandomSeed());
  const [selectedId, setSelectedId] = useState<string | null>(search.media ?? null);
  const [hasRestoredGalleryPrefs, setHasRestoredGalleryPrefs] = useState(false);

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
    if (displayPath === "" && recursive) {
      setRecursive(false);
    }
    if (displayPath === "" && comicMode) {
      setComicMode(false);
    }
  }, [comicMode, displayPath, recursive]);

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
    setRandomSeed(createRandomSeed());
  }, []);

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
