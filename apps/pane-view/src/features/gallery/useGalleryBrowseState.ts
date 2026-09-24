import type { GallerySortMode } from "@latch-works/media-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GalleryBrowseSearch } from "@/features/gallery/browse-search";
import {
  applyBrowseIntent,
  type BrowseIntent,
  buildBrowseSearch,
  listingRequestFor,
  type ResolvedBrowseState,
  resolveBrowseState,
  resolveInitialRedirect,
  type SeededBrowseState,
  snapshotRequestFor,
} from "@/features/gallery/browse-state-rules";
import {
  createLocalStorageBrowseStorage,
  type GalleryBrowseStorage,
  PERSISTED_BROWSE_STATE_DEFAULTS,
  type PersistedBrowseState,
  resolveRootKey,
} from "@/features/gallery/gallery-browse-storage";
import {
  createGalleryRandomSeed,
  type GalleryRandomSeed,
} from "@/features/gallery/gallery-random-seed";
import { useExcludedChildPaths } from "@/features/gallery/useExcludedChildPaths";
import type {
  GalleryListingQueryRequest,
  LibrarySnapshotRequest,
} from "@/features/library/library-queries";

/**
 * The one owner of gallery browse state (Plan 048): wires the rules in
 * browse-state-rules to the router (URL-owned fields) and to storage (local
 * fields and the remembered in-folder flags).
 */

export interface GalleryBrowseState extends ResolvedBrowseState {
  /**
   * The remembered in-folder recursive flag: the settings drawer's "default
   * recursive browsing". Unlike `recursive`, it is not folded off at the root.
   */
  rememberedRecursive: boolean;
  snapshotRequest: LibrarySnapshotRequest;
  listingRequest: GalleryListingQueryRequest;
  /** The current path's excluded direct-child folders (Plan 054). */
  excludedChildPaths: readonly string[];
  navigateToPath(path: string): void;
  submitSearch(query: string | undefined): void;
  selectMedia(mediaId: string | null): void;
  setRecursive(next: boolean): void;
  setComicMode(next: boolean): void;
  setSortMode(next: GallerySortMode): void;
  shuffle(): void;
  setDetailPanelOpen(next: boolean): void;
  toggleExcludedChild(childPath: string): void;
  /** Drop stored excludes not among the current path's live children (dialog open). */
  pruneExcludedChildren(livePaths: readonly string[]): void;
  buildBrowseSearch(patch: Partial<GalleryBrowseSearch>): GalleryBrowseSearch;
}

interface BrowseNavigateOptions {
  replace?: boolean;
  resetScroll?: boolean;
  search: GalleryBrowseSearch;
  to: "/";
}

/** The router's navigate, narrowed to what the browse state needs. */
type BrowseNavigate = (options: BrowseNavigateOptions) => Promise<void> | void;

export interface UseGalleryBrowseStateOptions {
  createSeed?: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed;
  navigate: BrowseNavigate;
  search: GalleryBrowseSearch;
  settings: { showImages: boolean; showVideos: boolean };
  storage?: GalleryBrowseStorage;
}

const defaultStorage = createLocalStorageBrowseStorage();

function withSeed(
  state: PersistedBrowseState,
  createSeed: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed,
): SeededBrowseState {
  const { randomSeed } = state;

  return randomSeed ? { ...state, randomSeed } : { ...state, randomSeed: createSeed() };
}

function samePersisted(left: PersistedBrowseState, right: PersistedBrowseState): boolean {
  return (
    left.comicMode === right.comicMode &&
    left.detailPanelOpen === right.detailPanelOpen &&
    left.lastPath === right.lastPath &&
    left.randomSeed === right.randomSeed &&
    left.recursive === right.recursive &&
    left.sortMode === right.sortMode
  );
}

export function useGalleryBrowseState({
  createSeed = createGalleryRandomSeed,
  navigate,
  search,
  settings,
  storage = defaultStorage,
}: UseGalleryBrowseStateOptions): GalleryBrowseState {
  // Both gallery routes render on the client only (`ssr: false`), so storage
  // is readable on the first render and the listing query starts with the
  // real seed and sort mode.
  const [persisted, setPersisted] = useState<SeededBrowseState>(() =>
    withSeed(storage.read() ?? PERSISTED_BROWSE_STATE_DEFAULTS, createSeed),
  );

  const state = useMemo(() => resolveBrowseState(search, persisted), [persisted, search]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const { excludedChildPaths, pruneExcludedChildren, toggleExcludedChild } = useExcludedChildPaths(
    state.path,
    storage,
  );

  // First-visit redirect, once.
  const initialPathCheckedRef = useRef(false);
  useEffect(() => {
    const redirectTo = resolveInitialRedirect(search, persisted, initialPathCheckedRef.current);
    initialPathCheckedRef.current = true;

    if (redirectTo) {
      void navigate({ search: redirectTo, to: "/" });
    }
  }, [navigate, persisted, search]);

  // Mirror the resolved state into storage (and per-root prefs) after each
  // change. The flags are remembered only inside a folder — at the root they
  // are folded off, and overwriting the remembered default there would defeat
  // the settings drawer's "default recursive browsing" toggle.
  const { comicMode, detailPanelOpen, folderModesEnabled, path, randomSeed, recursive, sortMode } =
    state;

  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;
  useEffect(() => {
    const base = persistedRef.current;

    const next: SeededBrowseState = {
      comicMode: folderModesEnabled ? comicMode : base.comicMode,
      detailPanelOpen,
      lastPath: path,
      randomSeed,
      recursive: folderModesEnabled ? recursive : base.recursive,
      sortMode,
    };

    storage.write(next);

    if (folderModesEnabled) {
      storage.writeRootPreferences(resolveRootKey(path), { comicMode, recursive, sortMode });
    }

    setPersisted((current) => (samePersisted(current, next) ? current : next));
  }, [
    comicMode,
    detailPanelOpen,
    folderModesEnabled,
    path,
    persisted,
    randomSeed,
    recursive,
    sortMode,
    storage,
  ]);

  const dispatch = useCallback(
    (intent: BrowseIntent) => {
      const remembered = persistedRef.current;
      const result = applyBrowseIntent(stateRef.current, intent, remembered, createSeed);

      if (result.navigate) {
        const { search: nextSearch, ...options } = result.navigate;
        void navigate({ ...options, search: nextSearch, to: "/" });
      }

      if (result.persisted) {
        const patch = result.persisted;
        setPersisted((current) => ({ ...current, ...patch }));
      }
    },
    [createSeed, navigate],
  );

  const snapshotRequest = useMemo(
    () => snapshotRequestFor({ comicMode, path, query: state.query, recursive }),
    [comicMode, path, recursive, state.query],
  );

  const listingRequest = useMemo(
    () =>
      listingRequestFor(
        { comicMode, path, query: state.query, randomSeed, recursive, sortMode },
        { showImages: settings.showImages, showVideos: settings.showVideos },
        excludedChildPaths,
      ),
    [
      comicMode,
      excludedChildPaths,
      path,
      randomSeed,
      recursive,
      settings.showImages,
      settings.showVideos,
      sortMode,
      state.query,
    ],
  );

  const intents = useMemo(
    () => ({
      navigateToPath: (nextPath: string) => dispatch({ path: nextPath, type: "navigateToPath" }),
      selectMedia: (mediaId: string | null) => dispatch({ mediaId, type: "selectMedia" }),
      setComicMode: (next: boolean) => dispatch({ next, type: "setComicMode" }),
      setDetailPanelOpen: (next: boolean) => dispatch({ next, type: "setDetailPanelOpen" }),
      setRecursive: (next: boolean) => dispatch({ next, type: "setRecursive" }),
      setSortMode: (next: GallerySortMode) => dispatch({ next, type: "setSortMode" }),
      shuffle: () => dispatch({ type: "shuffle" }),
      submitSearch: (query: string | undefined) => dispatch({ query, type: "submitSearch" }),
    }),
    [dispatch],
  );

  const buildSearch = useCallback(
    (patch: Partial<GalleryBrowseSearch>) => buildBrowseSearch(stateRef.current, patch),
    [],
  );

  return useMemo(
    () => ({
      ...state,
      ...intents,
      buildBrowseSearch: buildSearch,
      excludedChildPaths,
      listingRequest,
      pruneExcludedChildren,
      rememberedRecursive: persisted.recursive,
      snapshotRequest,
      toggleExcludedChild,
    }),
    [
      buildSearch,
      excludedChildPaths,
      intents,
      listingRequest,
      persisted.recursive,
      pruneExcludedChildren,
      snapshotRequest,
      state,
      toggleExcludedChild,
    ],
  );
}
