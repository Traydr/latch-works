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

/**
 * The one owner of gallery browse state (Plan 048).
 *
 * Sources of truth: the URL owns `path`, `q`, `media`, `recursive`, `comic`;
 * localStorage owns `sortMode`, `detailPanelOpen`, `randomSeed` and mirrors the
 * URL-owned flags so a URL without them resolves to the last choice. Every rule
 * (`comic ⇒ recursive`, `root ⇒ neither`, the toolbar coupling) is stated once
 * in the pure functions below; the hook only wires them to the router and to
 * storage. Intents write straight to their owner — no override layer.
 */

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
  const folderModesEnabled = canUseFolderBrowseModes(path);
  const comicMode = folderModesEnabled && (search.comic ?? base.comicMode);
  const recursive = folderModesEnabled && ((search.recursive ?? base.recursive) || comicMode);

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
    // Comic mode still reads its media through the snapshot until Plan 052;
    // every other mode lists media through the cursor listing, so the snapshot
    // carries folders and archive state only.
    mediaLimit: state.comicMode ? undefined : 0,
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
): GalleryListingQueryRequest {
  return {
    comicMode: state.comicMode,
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
 * selection. Flags are written only when true and only inside a folder.
 */
export function buildBrowseSearch(
  state: Pick<ResolvedBrowseState, "comicMode" | "path" | "query" | "recursive" | "selectedId">,
  patch: Partial<GalleryBrowseSearch>,
): GalleryBrowseSearch {
  const nextPath = Object.hasOwn(patch, "path") ? (patch.path ?? "") : state.path;
  const nextFolderModesEnabled = canUseFolderBrowseModes(nextPath);
  const comic = Object.hasOwn(patch, "comic") ? (patch.comic ?? false) : state.comicMode;
  const recursive = Object.hasOwn(patch, "recursive")
    ? (patch.recursive ?? false)
    : state.recursive;

  return {
    comic: nextFolderModesEnabled && comic ? true : undefined,
    media: Object.hasOwn(patch, "media") ? patch.media : (state.selectedId ?? undefined),
    path: nextPath || undefined,
    q: Object.hasOwn(patch, "q") ? patch.q : state.query,
    recursive: nextFolderModesEnabled && (recursive || comic) ? true : undefined,
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
 * - navigating to the root drops both flags;
 * - recursive off ⇒ comic off; recursive on leaves comic alone;
 * - comic on ⇒ recursive on; comic off ⇒ recursive off (the toolbar's
 *   long-standing coupling, preserved);
 * - shuffle switches to random and always changes the seed.
 */
export function applyBrowseIntent(
  state: ResolvedBrowseState,
  intent: BrowseIntent,
  createSeed: (previous?: GalleryRandomSeed | null) => GalleryRandomSeed = createGalleryRandomSeed,
): BrowseIntentResult {
  switch (intent.type) {
    case "navigateToPath":
      return {
        navigate: {
          search: buildBrowseSearch(state, {
            media: undefined,
            path: intent.path,
            recursive: intent.path === "" ? false : state.recursive,
          }),
        },
      };
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
    case "setRecursive":
      return {
        navigate: {
          replace: true,
          resetScroll: false,
          search: buildBrowseSearch(state, {
            comic: intent.next ? state.comicMode : false,
            recursive: intent.next,
          }),
        },
      };
    case "setComicMode":
      return {
        navigate: {
          replace: true,
          resetScroll: false,
          search: buildBrowseSearch(state, { comic: intent.next, recursive: intent.next }),
        },
      };
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
export function resolveInitialRedirect(
  search: GalleryBrowseSearch,
  persisted: PersistedBrowseState | null,
  alreadyChecked: boolean,
): { checked: boolean; redirectTo: GalleryBrowseSearch | null } {
  if (alreadyChecked) {
    return { checked: true, redirectTo: null };
  }
  if (!persisted) {
    return { checked: false, redirectTo: null };
  }
  if (search.path || !persisted.lastPath) {
    return { checked: true, redirectTo: null };
  }
  const comic = persisted.comicMode;
  return {
    checked: true,
    redirectTo: {
      comic: comic || undefined,
      media: undefined,
      path: persisted.lastPath,
      q: search.q,
      recursive: persisted.recursive || comic || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface GalleryBrowseState extends ResolvedBrowseState {
  snapshotRequest: LibrarySnapshotRequest;
  listingRequest: GalleryListingQueryRequest;
  navigateToPath(path: string): void;
  submitSearch(query: string | undefined): void;
  selectMedia(mediaId: string | null): void;
  setRecursive(next: boolean): void;
  setComicMode(next: boolean): void;
  setSortMode(next: GallerySortMode): void;
  shuffle(): void;
  setDetailPanelOpen(next: boolean): void;
  buildBrowseSearch(patch: Partial<GalleryBrowseSearch>): GalleryBrowseSearch;
}

export type BrowseNavigate = (options: {
  replace?: boolean;
  resetScroll?: boolean;
  search: GalleryBrowseSearch;
  to: "/";
}) => unknown;

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

  // Mirror the resolved state into storage (and per-root prefs) after each change.
  const { comicMode, detailPanelOpen, path, randomSeed, recursive, sortMode } = state;
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    const next: PersistedBrowseState = {
      comicMode,
      detailPanelOpen,
      lastPath: path,
      randomSeed,
      recursive,
      sortMode,
    };
    setPersisted((current) => (current && samePersisted(current, next) ? current : next));
    storage.write(next);
    storage.writeRootPreferences(resolveRootKey(path), { comicMode, recursive, sortMode });
  }, [comicMode, detailPanelOpen, hydrated, path, randomSeed, recursive, sortMode, storage]);

  const dispatch = useCallback(
    (intent: BrowseIntent) => {
      const result = applyBrowseIntent(stateRef.current, intent, createSeed);
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
      ),
    [
      comicMode,
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
  const buildSearch = useCallback(
    (patch: Partial<GalleryBrowseSearch>) => buildBrowseSearch(stateRef.current, patch),
    [],
  );

  return useMemo(
    () => ({
      ...state,
      buildBrowseSearch: buildSearch,
      listingRequest,
      navigateToPath,
      selectMedia,
      setComicMode,
      setDetailPanelOpen,
      setRecursive,
      setSortMode,
      shuffle,
      snapshotRequest,
      submitSearch,
    }),
    [
      buildSearch,
      listingRequest,
      navigateToPath,
      selectMedia,
      setComicMode,
      setDetailPanelOpen,
      setRecursive,
      setSortMode,
      shuffle,
      snapshotRequest,
      state,
      submitSearch,
    ],
  );
}
