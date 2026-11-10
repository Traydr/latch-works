import type { GallerySortMode } from "@latch-works/media-domain";
import type { GalleryBrowseSearch } from "@/features/gallery/browse-search";
import type { PersistedBrowseState } from "@/features/gallery/gallery-browse-storage";
import { createGalleryRandomSeed } from "@/features/gallery/gallery-random-seed";
import {
  type GalleryListingRequest,
  type GalleryRandomSeed,
  type LibrarySnapshotRequest,
  normalizeListingRequest,
  normalizeSnapshotRequest,
} from "@/features/library/listing-contract";

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
 * (`root ⇒ neither`, the toolbar coupling) is stated once in the functions
 * below; `comic ⇒ recursive` is the listing contract's. Intents write straight
 * to their owner — no override layer.
 */

/** The browse flags after the two folding rules: comic ⇒ recursive; root ⇒ neither. */
interface BrowseFlags {
  comicMode: boolean;
  folderModesEnabled: boolean;
  recursive: boolean;
}

/**
 * The one client statement of the flag rules. Resolution, URL construction,
 * the redirect, and folder entry from the root all go through it.
 */
function foldBrowseFlags(
  path: string,
  flags: { comic?: boolean; recursive?: boolean },
): BrowseFlags {
  const folderModesEnabled = path !== "";
  const comicMode = folderModesEnabled && (flags.comic ?? false);
  const recursive = folderModesEnabled && ((flags.recursive ?? false) || comicMode);

  return { comicMode, folderModesEnabled, recursive };
}

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
  const path = search.path ?? "";
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

/**
 * The snapshot request: the folder query only. Deliberately no flags or
 * excludes, which never change a folder row; sending them would churn the
 * query key on every toggle, blanking the exclude dialog mid-interaction for
 * a refetch that cannot change a single row. Reads the URL alone, so the
 * route loader can build it without localStorage.
 */
export function snapshotRequestFor(
  state: Pick<GalleryBrowseSearch, "path" | "q">,
): LibrarySnapshotRequest {
  return normalizeSnapshotRequest({ path: state.path, query: state.q });
}

export function listingRequestFor(
  state: Pick<
    ResolvedBrowseState,
    "comicMode" | "path" | "query" | "randomSeed" | "recursive" | "sortMode"
  >,
  settings: { showImages: boolean; showVideos: boolean },
  excludedPaths: readonly string[] = [],
): GalleryListingRequest {
  return normalizeListingRequest({
    comicMode: state.comicMode,
    excludedPaths: [...excludedPaths],
    path: state.path,
    query: state.query,
    randomSeed: state.randomSeed,
    recursive: state.recursive,
    showImages: settings.showImages,
    showVideos: settings.showVideos,
    sortMode: state.sortMode,
  });
}

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
 * persisted patch. Navigating to any folder ends a search; entering a folder
 * from the root applies the remembered flags (the settings drawer's "default
 * recursive browsing"); at the root, where the URL cannot hold the flags, the
 * toggles write that remembered default instead.
 */
export function applyBrowseIntent(
  state: ResolvedBrowseState,
  intent: BrowseIntent,
  remembered: Pick<PersistedBrowseState, "comicMode" | "recursive">,
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
      return {
        persisted: { randomSeed: createGalleryRandomSeed(state.randomSeed), sortMode: "random" },
      };
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
