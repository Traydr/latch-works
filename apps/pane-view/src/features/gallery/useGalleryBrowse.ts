import type { ComicEntry } from "@latch-works/media-domain";
import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  type QueryKey,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  entryMedia,
  type GalleryBrowseEntry,
  toGalleryBrowseEntries,
} from "@/features/gallery/gallery-browse-entry";
import { buildBrowseKey } from "@/features/gallery/gallery-page-helpers";
import {
  createServerGalleryPageSource,
  type GalleryPageSource,
} from "@/features/gallery/gallery-page-source";
import {
  type GalleryListingQueryRequest,
  galleryListingKeys,
  type LibrarySnapshotRequest,
  librarySnapshotKeys,
  useLibrarySnapshotQuery,
} from "@/features/library/library-queries";
import type { LibraryMediaItem } from "@/features/library/types";
import type { GalleryListingPage } from "../../server/library/gallery-listing";

/**
 * The gallery browse session (Plan 052): one cursor path for regular media
 * and comic summaries, ordered page accumulation, the population-change
 * policy, and movement across page boundaries. Callers ask it to load or
 * step; they never see cursors and never sort what it returns.
 *
 * Every loaded page of a listing lives in one TanStack infinite query, so the
 * page sequence has a single owner and at most one fetch at a time. A focus
 * refetch, a delete invalidation, and Refresh all re-walk the whole loaded
 * extent from a fresh page 1 and replace it in one write; later pages,
 * cursor, and exhaustion never outlive the data they were read from. Rendered
 * order is the pages in order with any key already present removed.
 */

interface GalleryPageState {
  cursor: string | null;
  error: unknown | null;
  hasMore: boolean;
  loading: boolean;
}

interface LoadNextPageResult {
  appendedEntryKeys: string[];
  appendedMediaIds: string[];
  exhausted: boolean;
}

export interface GalleryBrowseSession {
  /** Every media item in display order, including ones excluded from navigation. */
  allMedia: LibraryMediaItem[];
  browseKey: string;
  /** `browseKey` once its own listing is on screen; null while a placeholder is. */
  contentBrowseKey: string | null;
  /** Folder, media, and comic-summary entries in display order. */
  entries: GalleryBrowseEntry[];
  isReady: boolean;
  library: ReturnType<typeof useLibrarySnapshotQuery>["data"];
  /**
   * Why the current listing has no page to show once its query gave up;
   * null while it loads or once a page is on screen.
   */
  listingError: Error | null;
  loadNextPage(): Promise<LoadNextPageResult>;
  /** Media mode: media; comic mode: covers. Excludes `excludedMediaIds`. */
  media: LibraryMediaItem[];
  openComic(comicId: string): Promise<ComicEntry<LibraryMediaItem>>;
  page: GalleryPageState;
  /**
   * Reload the snapshot and every loaded listing page. Never rejects: a
   * failed reload keeps the pages already on screen.
   */
  refresh(): Promise<void>;
  showFetching: boolean;
  /** Either request in flight; spins the toolbar's refresh affordance. */
  showRefreshing: boolean;
  /**
   * True while the snapshot on screen belongs to the live browse; false while
   * `keepPreviousData` still shows the folder being left. Gates interactive
   * snapshot consumers — sidebar folders and sibling navigation.
   */
  snapshotIsCurrent: boolean;
  stepEntry(currentKey: string | null, direction: -1 | 1, loop: boolean): Promise<string | null>;
  stepMedia(currentId: string | null, direction: -1 | 1, loop: boolean): Promise<string | null>;
}

export interface UseGalleryBrowseOptions {
  /** Media ids to skip while stepping (deleted locally, awaiting the refetch). */
  excludedMediaIds?: ReadonlySet<string>;
  hydrated: boolean;
  listingRequest: GalleryListingQueryRequest;
  snapshotRequest: LibrarySnapshotRequest;
  source?: GalleryPageSource;
}

type GalleryListingData = InfiniteData<GalleryListingPage, string | null>;

const EXHAUSTED: LoadNextPageResult = {
  appendedEntryKeys: [],
  appendedMediaIds: [],
  exhausted: true,
};

/** Keeps the first occurrence of each key; order is otherwise preserved. */
function dedupeEntries(...lists: readonly (readonly GalleryBrowseEntry[])[]): GalleryBrowseEntry[] {
  const seen = new Set<string>();
  const merged: GalleryBrowseEntry[] = [];

  for (const list of lists) {
    for (const entry of list) {
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        merged.push(entry);
      }
    }
  }

  return merged;
}

function listingEntries(
  data: { pages: readonly GalleryListingPage[] } | undefined,
): GalleryBrowseEntry[] {
  return data ? dedupeEntries(...data.pages.map(toGalleryBrowseEntries)) : [];
}

/** The cursor of the page after `page`, or undefined when it is the last. */
function nextCursor(page: GalleryListingPage | undefined): string | undefined {
  return page?.page.hasMore && page.page.cursor ? page.page.cursor : undefined;
}

/** Resolves once no fetch of the listing is running, whoever started it. */
async function settleListing(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  for (;;) {
    const query = queryClient.getQueryCache().find({ exact: true, queryKey });
    const inFlight = query?.state.fetchStatus === "idle" ? undefined : query?.promise;

    if (!inFlight) return;
    await inFlight.catch(() => undefined);
  }
}

const defaultSource = createServerGalleryPageSource();

/** Thrown internally when a page resolves for a browse key that is no longer live. */
class StaleBrowseError extends Error {
  constructor() {
    super("Gallery browse changed while a page was loading");
    this.name = "StaleBrowseError";
  }
}

function galleryComicQueryKey(comicId: string, request: GalleryListingQueryRequest) {
  return [
    "gallery-comic",
    comicId,
    request.path ?? "",
    request.query ?? "",
    request.showImages,
    request.showVideos,
  ] as const;
}

export function useGalleryBrowse({
  excludedMediaIds,
  hydrated,
  listingRequest,
  snapshotRequest,
  source = defaultSource,
}: UseGalleryBrowseOptions): GalleryBrowseSession {
  const queryClient = useQueryClient();

  const {
    data: library,
    isFetching: isSnapshotFetching,
    isPlaceholderData: isSnapshotPlaceholderData,
  } = useLibrarySnapshotQuery(snapshotRequest);

  const {
    data: listing,
    error: listingQueryError,
    isFetching: isListingFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    isPlaceholderData,
  } = useInfiniteQuery<GalleryListingPage, Error, GalleryListingData, QueryKey, string | null>({
    getNextPageParam: nextCursor,
    initialPageParam: null,
    placeholderData: keepPreviousData,
    queryFn: async ({ pageParam }): Promise<GalleryListingPage> => {
      const page = await source.loadPage(
        pageParam === null ? listingRequest : { ...listingRequest, cursor: pageParam },
      );

      if (pageParam !== null && page.page.hasMore && page.page.cursor === pageParam) {
        throw new Error("Gallery listing cursor did not advance");
      }

      return page;
    },
    queryKey: galleryListingKeys.listing(listingRequest),
  });

  const browseKey = useMemo(
    () =>
      buildBrowseKey({
        comicMode: listingRequest.comicMode,
        excludedPaths: listingRequest.excludedPaths,
        path: listingRequest.path,
        query: listingRequest.query,
        randomSeed: listingRequest.randomSeed,
        recursive: listingRequest.recursive,
        showImages: listingRequest.showImages,
        showVideos: listingRequest.showVideos,
        sortMode: listingRequest.sortMode,
      }),
    [listingRequest],
  );

  const listingIsCurrent = Boolean(listing) && !isPlaceholderData;
  /**
   * The browse key of the listing on screen, or null while `keepPreviousData`
   * still shows another browse's pages. `browseKey` changes the moment the URL
   * does, a round trip before the entries follow, so anything keyed to the
   * content itself — thumbnail resolution above all — must use this instead.
   */
  const contentBrowseKey = listingIsCurrent ? browseKey : null;

  const entries = useMemo(() => listingEntries(listing), [listing]);

  const allMedia = useMemo(
    () =>
      entries.flatMap((entry) => {
        const item = entryMedia(entry);

        return item ? [item] : [];
      }),
    [entries],
  );

  const media = useMemo(
    () =>
      excludedMediaIds?.size ? allMedia.filter((item) => !excludedMediaIds.has(item.id)) : allMedia,
    [allMedia, excludedMediaIds],
  );

  // A placeholder's pagination belongs to the browse being left.
  const lastPage = listingIsCurrent ? listing?.pages.at(-1) : undefined;
  const cursor = lastPage?.page.cursor ?? null;
  const hasMore = lastPage?.page.hasMore ?? false;
  const pageError = isFetchNextPageError ? listingQueryError : null;

  const page: GalleryPageState = useMemo(
    () => ({ cursor, error: pageError, hasMore, loading: isFetchingNextPage }),
    [cursor, hasMore, isFetchingNextPage, pageError],
  );

  // Refs so awaited results never depend on a stale render.
  const liveRef = useRef({ browseKey, entries, hasMore, listingRequest, media });
  liveRef.current = { browseKey, entries, hasMore, listingRequest, media };

  // The running refresh. A next-page load waits for it, so it pages from the
  // refreshed listing rather than racing it.
  const refreshRef = useRef<Promise<void> | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The running next-page load, shared by every caller (infinite scroll and
  // the viewer stepping past the loaded end) so one page is loaded once.
  const nextPageRef = useRef<{ browseKey: string; promise: Promise<LoadNextPageResult> } | null>(
    null,
  );

  // Pagination facts are read from the query cache, never from a render:
  // the cache is written before any awaited fetch resolves.
  const loadNextPage = useCallback((): Promise<LoadNextPageResult> => {
    const { browseKey: key, listingRequest: request } = liveRef.current;
    const shared = nextPageRef.current;

    if (shared?.browseKey === key) {
      return shared.promise;
    }

    const queryKey = galleryListingKeys.listing(request);

    const load = async (): Promise<LoadNextPageResult> => {
      // Repeats only when another fetch replaced the pages under this one (a
      // Refresh or delete invalidation cancels it); the next page is then read
      // from whatever replaced them.
      for (;;) {
        await refreshRef.current;
        await settleListing(queryClient, queryKey);

        if (liveRef.current.browseKey !== key) {
          throw new StaleBrowseError();
        }

        const query = queryClient
          .getQueryCache()
          .find<GalleryListingData>({ exact: true, queryKey });

        const before = query?.state.data;

        if (!query || !before || !nextCursor(before.pages.at(-1))) {
          return EXHAUSTED;
        }

        const known = new Set(listingEntries(before).map((entry) => entry.key));
        await query.fetch(undefined, {
          cancelRefetch: false,
          meta: { fetchMore: { direction: "forward" } },
        });

        if (liveRef.current.browseKey !== key) {
          throw new StaleBrowseError();
        }

        const after = query.state.data;

        if (after && after.pages.length > before.pages.length) {
          const appended = listingEntries(after).filter((entry) => !known.has(entry.key));

          return {
            appendedEntryKeys: appended.map((entry) => entry.key),
            appendedMediaIds: appended.flatMap((entry) => {
              const item = entryMedia(entry);

              return item ? [item.id] : [];
            }),
            exhausted: !nextCursor(after.pages.at(-1)),
          };
        }
      }
    };

    const promise = load().finally(() => {
      if (nextPageRef.current?.promise === promise) {
        nextPageRef.current = null;
      }
    });

    nextPageRef.current = { browseKey: key, promise };

    return promise;
  }, [queryClient]);

  const refresh = useCallback((): Promise<void> => {
    if (refreshRef.current) {
      return refreshRef.current;
    }

    const { browseKey: key, listingRequest: request } = liveRef.current;
    const queryKey = galleryListingKeys.listing(request);
    setRefreshing(true);

    const reloadListing = async () => {
      // Other browse keys' listings are marked stale without a fetch; the
      // live one is re-read below.
      await queryClient.invalidateQueries({
        queryKey: galleryListingKeys.all,
        refetchType: "none",
      });
      // A fetch already running (a Load more, a focus refetch) finishes
      // first: its page is part of the extent re-read here, and its result
      // cannot land on top of the refreshed one.
      await settleListing(queryClient, queryKey);

      if (liveRef.current.browseKey === key) {
        await queryClient.refetchQueries({ exact: true, queryKey });
      }
    };

    const run = (async () => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: librarySnapshotKeys.all }),
          reloadListing(),
        ]);
      } finally {
        refreshRef.current = null;
        setRefreshing(false);
      }
    })();

    refreshRef.current = run;

    return run;
  }, [queryClient]);

  // One boundary algorithm for media ids and entry keys (Plan 052, Step 3):
  // move within the loaded sequence; at the loaded end load before looping;
  // stay on the first item backward while more pages exist. Every read of the
  // sequence after an await comes from the live ref, and a result that
  // belongs to another browse key is discarded.
  const stepThrough = useCallback(
    async <T extends { id: string } | { key: string }>(
      pick: () => readonly T[],
      identify: (item: T) => string,
      firstAppended: (result: LoadNextPageResult) => string | undefined,
      current: string | null,
      direction: -1 | 1,
      loop: boolean,
    ): Promise<string | null> => {
      const key = liveRef.current.browseKey;

      const wrapForward = () => {
        // Read the sequence again: a page-1 refetch or a local deletion may
        // have changed it while the load was in flight.
        const first = pick()[0];

        return loop && first && identify(first) !== current ? identify(first) : null;
      };

      const sequence = pick();
      const index = current ? sequence.findIndex((item) => identify(item) === current) : -1;

      if (direction === 1) {
        const next = sequence[index + 1];

        if (next) return identify(next);

        if (liveRef.current.hasMore) {
          try {
            const result = await loadNextPage();

            if (liveRef.current.browseKey !== key) return null;
            const appended = firstAppended(result);

            if (appended) return appended;

            if (!result.exhausted) return null;
          } catch {
            return null;
          }
        }

        return wrapForward();
      }

      const previous = index > 0 ? sequence[index - 1] : undefined;

      if (previous) return identify(previous);
      const first = index < 0 ? sequence[0] : undefined;

      if (first) return identify(first);

      // Decision 7: no backward wrap while more pages exist.
      if (liveRef.current.hasMore) return null;
      const last = sequence.at(-1);

      return loop && last && identify(last) !== current ? identify(last) : null;
    },
    [loadNextPage],
  );

  const stepMedia = useCallback(
    (currentId: string | null, direction: -1 | 1, loop: boolean) =>
      stepThrough(
        () => liveRef.current.media,
        (item) => item.id,
        (result) => result.appendedMediaIds[0],
        currentId,
        direction,
        loop,
      ),
    [stepThrough],
  );

  const stepEntry = useCallback(
    (currentKey: string | null, direction: -1 | 1, loop: boolean) =>
      stepThrough(
        () => liveRef.current.entries,
        (entry) => entry.key,
        (result) => result.appendedEntryKeys[0],
        currentKey,
        direction,
        loop,
      ),
    [stepThrough],
  );

  const openComic = useCallback(
    (comicId: string): Promise<ComicEntry<LibraryMediaItem>> => {
      const request = liveRef.current.listingRequest;

      return queryClient.fetchQuery({
        queryFn: () =>
          source.loadComic({
            comicId,
            path: request.path,
            query: request.query,
            showImages: request.showImages,
            showVideos: request.showVideos,
          }),
        queryKey: galleryComicQueryKey(comicId, request),
        staleTime: 5 * 60 * 1000,
      });
    },
    [queryClient, source],
  );

  // A listing refetch, not a next-page load, which reports through `page`.
  const isListingRefetching = isListingFetching && !isFetchingNextPage;
  // The listing alone: the snapshot fills the sidebar, which reports its own
  // loading state, and folding it in here dimmed the grid for a request that
  // cannot change a single tile.
  const showFetching = hydrated && (isListingRefetching || refreshing);
  // The toolbar's refresh affordance, though, covers both requests: a
  // snapshot-only refetch should spin it even though no tile can change.
  const showRefreshing = hydrated && (isSnapshotFetching || isListingRefetching || refreshing);
  // Same shape as contentBrowseKey, for the other query: until the snapshot
  // belongs to this browse it describes the folder being left, so consumers
  // that act on it — sidebar folders, sibling navigation — must wait.
  const snapshotIsCurrent = !isSnapshotPlaceholderData;
  // The grid is served entirely by the listing, folder tiles included; the
  // snapshot only feeds the sidebar and sibling-folder navigation. Waiting on
  // it here would hold every tile for the slower of the two requests.
  const isReady = Boolean(listing);
  const listingError = !listing && listingQueryError ? listingQueryError : null;

  // A fresh object per render: every consumer destructures fields, and no
  // effect or memo depends on the session's container identity, so the memo
  // (and its duplicated dependency list) bought nothing.
  return {
    allMedia,
    browseKey,
    contentBrowseKey,
    entries,
    isReady,
    library,
    listingError,
    loadNextPage,
    media,
    openComic,
    page,
    refresh,
    showFetching,
    showRefreshing,
    snapshotIsCurrent,
    stepEntry,
    stepMedia,
  };
}
