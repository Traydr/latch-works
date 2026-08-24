import type { GallerySortMode } from "@latch-works/media-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canUseFolderBrowseModes,
  displayPathFromSearch,
  type GalleryBrowseSearch,
} from "@/features/gallery/browse-search";
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
import type {
  GalleryListingQueryRequest,
  LibrarySnapshotRequest,
} from "@/features/library/library-queries";
import { EXCLUDED_PATHS_LIMIT } from "@/features/library/library-service";

/**
 * The one owner of gallery browse state (Plan 048).
 *
 * Sources of truth: the URL owns `path`, `q`, `media`, `recursive`, `comic`
 * and is the only thing the flags resolve from — a URL without a flag means
 * off. localStorage owns `sortMode`, `detailPanelOpen`, `randomSeed`, and the
 * remembered in-folder flags, which seed the URL in exactly two places: the
 * one-shot first-visit redirect and entering a folder from the archive root
 * (the "default recursive browsing" the settings drawer offers). Every rule
 * (`comic ⇒ recursive`, `root ⇒ neither`, the toolbar coupling) is stated once
 * in the pure functions below; the hook only wires them to the router and to
 * storage. Intents write straight to their owner — no override layer.
 */

/** The browse flags after the two folding rules: comic ⇒ recursive; root ⇒ neither. */
export interface BrowseFlags {
  comicMode: boolean;
  folderModesEnabled: boolean;
  recursive: boolean;
}

/**
 * The one client statement of the flag rules. Resolution, URL construction,
 * the redirect, and folder entry from the root all go through it.
 */
export function foldBrowseFlags(
  path: string,
  flags: { comic?: boolean; recursive?: boolean },
): BrowseFlags {
  const folderModesEnabled = canUseFolderBrowseModes(path);
  const comicMode = folderModesEnabled && (flags.comic ?? false);
  const recursive = folderModesEnabled && ((flags.recursive ?? false) || comicMode);
  return { comicMode, folderModesEnabled, recursive };
}

// ---------------------------------------------------------------------------
// Resolved state
// ---------------------------------------------------------------------------

export interface ResolvedBrowseState {
  /** "" is the archive root. */
  path: string;
  query: string | undefined;
  /** The URL's `media`; the page falls back to the first visible item. */
  selectedId: string | null;
  /** Already folded: comic ⇒ recursive; root ⇒ false. */
  recursive: boolean;
  /** Root ⇒ false. */
  comicMode: boolean;
  folderModesEnabled: boolean;
  sortMode: GallerySortMode;
  randomSeed: GalleryRandomSeed;
  detailPanelOpen: boolean;
  /** True once localStorage has been read (the URL is always available). */
  hydrated: boolean;
}

/** Stands in for the seed until storage has been read; never persisted. */
export const PLACEHOLDER_RANDOM_SEED: GalleryRandomSeed = "0".repeat(32);

export function resolveBrowseState(
  search: GalleryBrowseSearch,
  persisted: PersistedBrowseState | null,
  hydrated: boolean,
): ResolvedBrowseState {
  const base = hydrated && persisted ? persisted : PERSISTED_BROWSE_STATE_DEFAULTS;
  const path = displayPathFromSearch(search.path);
  const { comicMode, folderModesEnabled, recursive } = foldBrowseFlags(path, search);

  return {
    comicMode,
    detailPanelOpen: base.detailPanelOpen,
    folderModesEnabled,
    hydrated,
    path,
    query: search.q,
    randomSeed: base.randomSeed ?? PLACEHOLDER_RANDOM_SEED,
    recursive,
    selectedId: search.media ?? null,
    sortMode: base.sortMode,
  };
}

// ---------------------------------------------------------------------------
// Requests — the only snapshot/listing requests gallery code may build
// ---------------------------------------------------------------------------

/** URL-only snapshot request for the route loader (no localStorage on the loader path). */
export function browseSnapshotRequestFromSearch(
  search: GalleryBrowseSearch,
): LibrarySnapshotRequest {
  return snapshotRequestFor(resolveBrowseState(search, null, false));
}

export function snapshotRequestFor(
  state: Pick<ResolvedBrowseState, "comicMode" | "path" | "query" | "recursive">,
): LibrarySnapshotRequest {
  return {
    comicMode: state.comicMode,
    // Deliberately no excludedPaths: the snapshot is the folder and
    // archive-state query only (mediaLimit 0), and excludes never prune
    // folders. Sending them would churn the snapshot query key on every
    // toggle, blanking the exclude dialog mid-interaction (and resetting its
    // scroll) for a refetch that cannot change a single row.
    mediaLimit: 0,
    path: state.path || undefined,
    query: state.query,
    recursive: state.recursive,
  };
}

export function listingRequestFor(
  state: Pick<
    ResolvedBrowseState,
    "comicMode" | "path" | "query" | "randomSeed" | "recursive" | "sortMode"
  >,
  settings: { showImages: boolean; showVideos: boolean },
  excludedPaths: readonly string[] = [],
): GalleryListingQueryRequest {
  return {
    comicMode: state.comicMode,
    // Excludes ride the request only while the folded recursive flag is on
    // (Plan 054, Decision 3); a path with no stored entry contributes nothing.
    // Trimmed to the server's cap so an oversized stored list degrades to a
    // partial exclude instead of a rejected request.
    excludedPaths:
      state.recursive && excludedPaths.length > 0
        ? excludedPaths.slice(0, EXCLUDED_PATHS_LIMIT)
        : undefined,
    path: state.path || undefined,
    query: state.query,
    randomSeed: state.randomSeed,
    recursive: state.recursive,
    showImages: settings.showImages,
    showVideos: settings.showVideos,
    sortMode: state.sortMode,
  };
}

// ---------------------------------------------------------------------------
// Search building and intents
// ---------------------------------------------------------------------------

/**
 * Build the next URL search from the current state and a patch. A key present
 * in the patch overrides the state even when its value is `undefined`, so
 * `{ q: undefined }` clears the query and `{ media: undefined }` clears the
 * selection. Flags are folded once more and written only when true.
 */
export function buildBrowseSearch(
  state: Pick<ResolvedBrowseState, "comicMode" | "path" | "query" | "recursive" | "selectedId">,
  patch: Partial<GalleryBrowseSearch>,
): GalleryBrowseSearch {
  const nextPath = Object.hasOwn(patch, "path") ? (patch.path ?? "") : state.path;
  const flags = foldBrowseFlags(nextPath, {
    comic: Object.hasOwn(patch, "comic") ? patch.comic : state.comicMode,
    recursive: Object.hasOwn(patch, "recursive") ? patch.recursive : state.recursive,
  });

  return {
    comic: flags.comicMode || undefined,
    media: Object.hasOwn(patch, "media") ? patch.media : (state.selectedId ?? undefined),
    path: nextPath || undefined,
    q: Object.hasOwn(patch, "q") ? patch.q : state.query,
    recursive: flags.recursive || undefined,
  };
}

export type BrowseIntent =
  | { type: "navigateToPath"; path: string }
  | { type: "submitSearch"; query: string | undefined }
  | { type: "selectMedia"; mediaId: string | null }
  | { type: "setRecursive"; next: boolean }
  | { type: "setComicMode"; next: boolean }
  | { type: "setSortMode"; next: GallerySortMode }
  | { type: "shuffle" }
  | { type: "setDetailPanelOpen"; next: boolean };

export interface BrowseNavigation {
  replace?: boolean;
  resetScroll?: boolean;
  search: GalleryBrowseSearch;
}

export interface BrowseIntentResult {
  navigate?: BrowseNavigation;
  persisted?: Partial<PersistedBrowseState>;
}

/**
 * What an intent does: URL-owned fields produce a navigation, local fields a
 * persisted patch. Rules stated here and nowhere else on the client:
 * - navigating to the root drops both flags from the URL; entering a folder
 *   from the root applies the remembered flags — the settings drawer's
 *   "default recursive browsing" default, which is the last in-folder choice
 *   or whatever the toggles set at the root;
 * - recursive off ⇒ comic off; recursive on leaves comic alone;
 * - comic on ⇒ recursive on; comic off ⇒ recursive off (the toolbar's
 *   long-standing coupling, preserved);
 * - at the root, where the URL cannot hold the flags, the toggles write the
 *   remembered default instead;
 * - shuffle switches to random and always changes the seed.
 */
export function applyBrowseIntent(
  state: ResolvedBrowseState,
  intent: BrowseIntent,
  remembered: Pick<PersistedBrowseState, "comicMode" | "recursive">,
  createSeed: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed = createGalleryRandomSeed,
): BrowseIntentResult {
  switch (intent.type) {
    case "navigateToPath": {
      if (intent.path === "") {
        return {
          navigate: { search: buildBrowseSearch(state, { media: undefined, path: "" }) },
        };
      }
      const flags = state.folderModesEnabled ? state : remembered;
      return {
        navigate: {
          search: buildBrowseSearch(state, {
            comic: flags.comicMode,
            media: undefined,
            path: intent.path,
            recursive: flags.recursive,
          }),
        },
      };
    }
    case "submitSearch":
      return {
        navigate: {
          search: buildBrowseSearch(state, {
            media: undefined,
            path: state.path,
            q: intent.query?.trim() || undefined,
          }),
        },
      };
    case "selectMedia":
      return {
        navigate: {
          replace: true,
          resetScroll: false,
          search: buildBrowseSearch(state, { media: intent.mediaId ?? undefined }),
        },
      };
    case "setRecursive": {
      const flags = { comic: intent.next ? state.comicMode : false, recursive: intent.next };
      if (!state.folderModesEnabled) {
        return { persisted: { comicMode: flags.comic, recursive: flags.recursive } };
      }
      return {
        navigate: { replace: true, resetScroll: false, search: buildBrowseSearch(state, flags) },
      };
    }
    case "setComicMode": {
      const flags = { comic: intent.next, recursive: intent.next };
      if (!state.folderModesEnabled) {
        return { persisted: { comicMode: flags.comic, recursive: flags.recursive } };
      }
      return {
        navigate: { replace: true, resetScroll: false, search: buildBrowseSearch(state, flags) },
      };
    }
    case "setSortMode":
      return { persisted: { sortMode: intent.next } };
    case "shuffle":
      return { persisted: { randomSeed: createSeed(state.randomSeed), sortMode: "random" } };
    case "setDetailPanelOpen":
      return { persisted: { detailPanelOpen: intent.next } };
  }
}

/**
 * The one-shot first-visit rule: a URL without `path`, seen for the first time
 * after storage is read, redirects to the last folder with the last flags.
 * Any later visit to the root (explicit navigation, back button) stays put.
 */
export interface InitialRedirectDecision {
  checked: boolean;
  redirectTo: GalleryBrowseSearch | null;
}

export function resolveInitialRedirect(
  search: GalleryBrowseSearch,
  persisted: PersistedBrowseState | null,
  alreadyChecked: boolean,
): InitialRedirectDecision {
  if (alreadyChecked) {
    return { checked: true, redirectTo: null };
  }
  if (!persisted) {
    return { checked: false, redirectTo: null };
  }
  if (search.path || !persisted.lastPath) {
    return { checked: true, redirectTo: null };
  }
  const flags = foldBrowseFlags(persisted.lastPath, {
    comic: persisted.comicMode,
    recursive: persisted.recursive,
  });
  return {
    checked: true,
    redirectTo: {
      comic: flags.comicMode || undefined,
      media: undefined,
      path: persisted.lastPath,
      q: search.q,
      recursive: flags.recursive || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface GalleryBrowseState extends ResolvedBrowseState {
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

export interface BrowseNavigateOptions {
  replace?: boolean;
  resetScroll?: boolean;
  search: GalleryBrowseSearch;
  to: "/";
}

/** The router's navigate, narrowed to what the browse state needs. */
export type BrowseNavigate = (options: BrowseNavigateOptions) => Promise<void> | void;

export interface UseGalleryBrowseStateOptions {
  createSeed?: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed;
  navigate: BrowseNavigate;
  search: GalleryBrowseSearch;
  settings: { showImages: boolean; showVideos: boolean };
  storage?: GalleryBrowseStorage;
}

const defaultStorage = createLocalStorageBrowseStorage();

function withSeed(
  state: PersistedBrowseState | null,
  createSeed: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed,
): PersistedBrowseState | null {
  if (!state) {
    return null;
  }
  return state.randomSeed ? state : { ...state, randomSeed: createSeed() };
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
  // Read synchronously where storage exists (client) so the first render is
  // already hydrated and the listing query starts with the real seed and
  // sort mode; the effect below covers a server render.
  const [persisted, setPersisted] = useState<PersistedBrowseState | null>(() =>
    withSeed(storage.read(), createSeed),
  );

  useEffect(() => {
    if (persisted === null) {
      const read = withSeed(storage.read(), createSeed);
      if (read) {
        setPersisted(read);
      }
    }
  }, [createSeed, persisted, storage]);

  const hydrated = persisted !== null;
  const state = useMemo(
    () => resolveBrowseState(search, persisted, hydrated),
    [hydrated, persisted, search],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  // Plan 054: the current path's exclude list, mirrored from storage. The
  // render-time adjust rehydrates it the moment the path changes; the toggle
  // and prune intents below write through to storage and keep the mirror in
  // step even when a storage write fails silently.
  const [excludes, setExcludes] = useState<{ list: string[]; path: string }>(() => ({
    list: storage.readExcludedChildPaths(state.path),
    path: state.path,
  }));
  if (excludes.path !== state.path) {
    setExcludes({ list: storage.readExcludedChildPaths(state.path), path: state.path });
  }
  const excludedChildPaths = excludes.list;

  // First-visit redirect, once.
  const initialPathCheckedRef = useRef(false);
  useEffect(() => {
    const { checked, redirectTo } = resolveInitialRedirect(
      search,
      persisted,
      initialPathCheckedRef.current,
    );
    initialPathCheckedRef.current = checked;
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
    if (!hydrated) {
      return;
    }
    const base = persistedRef.current ?? PERSISTED_BROWSE_STATE_DEFAULTS;
    const next: PersistedBrowseState = {
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
    setPersisted((current) => (current && samePersisted(current, next) ? current : next));
  }, [
    comicMode,
    detailPanelOpen,
    folderModesEnabled,
    hydrated,
    path,
    persisted,
    randomSeed,
    recursive,
    sortMode,
    storage,
  ]);

  const dispatch = useCallback(
    (intent: BrowseIntent) => {
      const remembered = persistedRef.current ?? PERSISTED_BROWSE_STATE_DEFAULTS;
      const result = applyBrowseIntent(stateRef.current, intent, remembered, createSeed);
      if (result.navigate) {
        const { search: nextSearch, ...options } = result.navigate;
        void navigate({ ...options, search: nextSearch, to: "/" });
      }
      if (result.persisted) {
        const patch = result.persisted;
        setPersisted((current) => ({
          ...(current ?? PERSISTED_BROWSE_STATE_DEFAULTS),
          ...patch,
        }));
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

  const navigateToPath = useCallback(
    (nextPath: string) => dispatch({ path: nextPath, type: "navigateToPath" }),
    [dispatch],
  );
  const submitSearch = useCallback(
    (query: string | undefined) => dispatch({ query, type: "submitSearch" }),
    [dispatch],
  );
  const selectMedia = useCallback(
    (mediaId: string | null) => dispatch({ mediaId, type: "selectMedia" }),
    [dispatch],
  );
  const setRecursive = useCallback(
    (next: boolean) => dispatch({ next, type: "setRecursive" }),
    [dispatch],
  );
  const setComicMode = useCallback(
    (next: boolean) => dispatch({ next, type: "setComicMode" }),
    [dispatch],
  );
  const setSortMode = useCallback(
    (next: GallerySortMode) => dispatch({ next, type: "setSortMode" }),
    [dispatch],
  );
  const shuffle = useCallback(() => dispatch({ type: "shuffle" }), [dispatch]);
  const setDetailPanelOpen = useCallback(
    (next: boolean) => dispatch({ next, type: "setDetailPanelOpen" }),
    [dispatch],
  );
  const toggleExcludedChild = useCallback(
    (childPath: string) => {
      const currentPath = stateRef.current.path;
      const stored = storage.readExcludedChildPaths(currentPath);
      const next = stored.includes(childPath)
        ? stored.filter((path) => path !== childPath)
        : [...stored, childPath];
      storage.writeExcludedChildPaths(currentPath, next);
      setExcludes({ list: next, path: currentPath });
    },
    [storage],
  );
  const pruneExcludedChildren = useCallback(
    (livePaths: readonly string[]) => {
      const currentPath = stateRef.current.path;
      const stored = storage.readExcludedChildPaths(currentPath);
      const live = new Set(livePaths);
      const pruned = stored.filter((path) => live.has(path));
      if (pruned.length === stored.length) {
        return;
      }
      storage.writeExcludedChildPaths(currentPath, pruned);
      setExcludes({ list: pruned, path: currentPath });
    },
    [storage],
  );
  const buildSearch = useCallback(
    (patch: Partial<GalleryBrowseSearch>) => buildBrowseSearch(stateRef.current, patch),
    [],
  );

  return useMemo(
    () => ({
      ...state,
      buildBrowseSearch: buildSearch,
      excludedChildPaths,
      listingRequest,
      navigateToPath,
      pruneExcludedChildren,
      selectMedia,
      setComicMode,
      setDetailPanelOpen,
      setRecursive,
      setSortMode,
      shuffle,
      snapshotRequest,
      submitSearch,
      toggleExcludedChild,
    }),
    [
      buildSearch,
      excludedChildPaths,
      listingRequest,
      navigateToPath,
      pruneExcludedChildren,
      selectMedia,
      setComicMode,
      setDetailPanelOpen,
      setRecursive,
      setSortMode,
      shuffle,
      snapshotRequest,
      state,
      submitSearch,
      toggleExcludedChild,
    ],
  );
}
