import type { GallerySortMode } from "@latch-works/media-domain";
import {
  canUseFolderBrowseModes,
  displayPathFromSearch,
  type GalleryBrowseSearch,
} from "@/features/gallery/browse-search";
import type { PersistedBrowseState } from "@/features/gallery/gallery-browse-storage";
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
 * The rules of gallery browse state (Plan 048), with no React in them;
 * useGalleryBrowseState wires them to the router and to storage.
 *
 * Sources of truth: the URL owns `path`, `q`, `media`, `recursive`, `comic`
 * and is the only thing the flags resolve from — a URL without a flag means
 * off. localStorage owns `sortMode`, `detailPanelOpen`, `randomSeed`, and the
 * remembered in-folder flags, which seed the URL in exactly two places: the
 * one-shot first-visit redirect and entering a folder from the archive root
 * (the "default recursive browsing" the settings drawer offers). Every rule
 * (`comic ⇒ recursive`, `root ⇒ neither`, the toolbar coupling) is stated once
 * in the functions below. Intents write straight to their owner — no override
 * layer.
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
}

/** The stored browse state once the hook has given it a seed. */
export type SeededBrowseState = PersistedBrowseState & { randomSeed: GalleryRandomSeed };

export function resolveBrowseState(
  search: GalleryBrowseSearch,
  persisted: SeededBrowseState,
): ResolvedBrowseState {
  const path = displayPathFromSearch(search.path);
  const { comicMode, folderModesEnabled, recursive } = foldBrowseFlags(path, search);

  return {
    comicMode,
    detailPanelOpen: persisted.detailPanelOpen,
    folderModesEnabled,
    path,
    query: search.q,
    randomSeed: persisted.randomSeed,
    recursive,
    selectedId: search.media ?? null,
    sortMode: persisted.sortMode,
  };
}

// ---------------------------------------------------------------------------
// Requests — the only snapshot/listing requests gallery code may build
// ---------------------------------------------------------------------------

/** URL-only snapshot request for the route loader (no localStorage on the loader path). */
export function browseSnapshotRequestFromSearch(
  search: GalleryBrowseSearch,
): LibrarySnapshotRequest {
  const path = displayPathFromSearch(search.path);
  const { comicMode, recursive } = foldBrowseFlags(path, search);

  return snapshotRequestFor({ comicMode, path, query: search.q, recursive });
}

export function snapshotRequestFor(
  state: Pick<ResolvedBrowseState, "comicMode" | "path" | "query" | "recursive">,
): LibrarySnapshotRequest {
  return {
    comicMode: state.comicMode,
    // Deliberately no excludedPaths: the snapshot is the folder query only,
    // and excludes never prune folders. Sending them would churn the snapshot
    // query key on every toggle, blanking the exclude dialog mid-interaction
    // (and resetting its scroll) for a refetch that cannot change a single row.
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

interface BrowseNavigation {
  replace?: boolean;
  resetScroll?: boolean;
  search: GalleryBrowseSearch;
}

export interface BrowseIntentResult {
  navigate?: BrowseNavigation;
  persisted?: Partial<SeededBrowseState>;
}

/**
 * What an intent does: URL-owned fields produce a navigation, local fields a
 * persisted patch. Rules stated here and nowhere else on the client:
 * - navigating to any folder (the root included) ends a search: the query is
 *   dropped so the folder shows its own contents;
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
          navigate: {
            search: buildBrowseSearch(state, { media: undefined, path: "", q: undefined }),
          },
        };
      }

      const flags = state.folderModesEnabled ? state : remembered;

      return {
        navigate: {
          search: buildBrowseSearch(state, {
            comic: flags.comicMode,
            media: undefined,
            path: intent.path,
            q: undefined,
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
      // At the root the URL holds no flags, so "leave comic alone" means the
      // remembered comic flag, not the folded-off one.
      if (!state.folderModesEnabled) {
        return {
          persisted: {
            comicMode: intent.next ? remembered.comicMode : false,
            recursive: intent.next,
          },
        };
      }

      const flags = { comic: intent.next ? state.comicMode : false, recursive: intent.next };

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
 * The one-shot first-visit rule: a URL without `path`, seen for the first time,
 * redirects to the last folder with the last flags. Any later visit to the
 * root (explicit navigation, back button) stays put. Null means stay.
 */
export function resolveInitialRedirect(
  search: GalleryBrowseSearch,
  persisted: PersistedBrowseState,
  alreadyChecked: boolean,
): GalleryBrowseSearch | null {
  if (alreadyChecked || search.path || !persisted.lastPath) {
    return null;
  }

  const flags = foldBrowseFlags(persisted.lastPath, {
    comic: persisted.comicMode,
    recursive: persisted.recursive,
  });

  return {
    comic: flags.comicMode || undefined,
    media: undefined,
    path: persisted.lastPath,
    q: search.q,
    recursive: flags.recursive || undefined,
  };
}
