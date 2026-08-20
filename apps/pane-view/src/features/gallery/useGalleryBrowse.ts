import type { ComicEntry } from "@latch-works/media-domain";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Page 1 is a TanStack query (so delete invalidation and focus refetch keep
 * working); pages 2..n are appended imperatively through one shared in-flight
 * request. Rendered order is: current page 1, then accumulated pages with any
 * key already present removed — page 1 under a fixed seed is a prefix of the
 * same permutation, so a refetch that overlaps page 2 dedupes without moving
 * anything.
 */

export interface GalleryPageState {
  cursor: string | null;
  error: unknown | null;
  hasMore: boolean;
  loading: boolean;
}

export interface LoadNextPageResult {
  appendedEntryKeys: string[];
  appendedMediaIds: string[];
  exhausted: boolean;
}

export interface GalleryBrowseSession {
  /** Every media item in display order, including ones excluded from navigation. */
  allMedia: LibraryMediaItem[];
  browseKey: string;
  /** Folder, media, and comic-summary entries in display order. */
  entries: GalleryBrowseEntry[];
  isReady: boolean;
  library: ReturnType<typeof useLibrarySnapshotQuery>["data"];
  loadNextPage(): Promise<LoadNextPageResult>;
  /** Media mode: media; comic mode: covers. Excludes `excludedMediaIds`. */
  media: LibraryMediaItem[];
  openComic(comicId: string): Promise<ComicEntry<LibraryMediaItem>>;
  page: GalleryPageState;
  showFetching: boolean;
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

interface Accumulation {
  browseKey: string;
  cursor: string | null;
  entries: GalleryBrowseEntry[];
  error: unknown | null;
  hasMore: boolean | null;
  /** A next-page request for this browse key is in flight. */
  loading: boolean;
}

function emptyAccumulation(browseKey: string): Accumulation {
  return { browseKey, cursor: null, entries: [], error: null, hasMore: null, loading: false };
}

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

const defaultSource = createServerGalleryPageSource();

/** Thrown internally when a page resolves for a browse key that is no longer live. */
class StaleBrowseError extends Error {
  constructor() {
    super("Gallery browse changed while a page was loading");
    this.name = "StaleBrowseError";
  }
}

export function galleryComicQueryKey(comicId: string, request: GalleryListingQueryRequest) {
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
  const { data: library, isFetching: isSnapshotFetching } =
    useLibrarySnapshotQuery(snapshotRequest);
  const {
    data: firstPage,
    isFetching: isListingFetching,
    isPlaceholderData,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryFn: (): Promise<GalleryListingPage> => source.loadPage(listingRequest),
    queryKey: galleryListingKeys.listing(listingRequest),
  });

  const browseKey = useMemo(
    () =>
      buildBrowseKey({
        comicMode: listingRequest.comicMode,
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

  // Accumulated pages 2..n. Anything stored under another browse key is stale
  // and read as empty; the effect below drops it once the key has changed.
  // Loading is part of the accumulation so it is keyed the same way.
  const [stored, setStored] = useState<Accumulation>(() => emptyAccumulation(browseKey));
  const accumulation = stored.browseKey === browseKey ? stored : emptyAccumulation(browseKey);
  const inFlightRef = useRef<{ browseKey: string; promise: Promise<LoadNextPageResult> } | null>(
    null,
  );

  // Only the browse key that issued a request may commit its result. A page
  // that resolves after the user moved to another folder, seed, or filter is
  // dropped: it must neither overwrite the live session nor revive the old one.
  const updateAccumulation = useCallback(
    (key: string, update: (current: Accumulation) => Accumulation) => {
      setStored((current) => (current.browseKey === key ? update(current) : current));
    },
    [],
  );

  useEffect(() => {
    if (stored.browseKey !== browseKey) {
      setStored(emptyAccumulation(browseKey));
    }
  }, [browseKey, stored.browseKey]);

  const firstPageIsCurrent = Boolean(firstPage) && !isPlaceholderData;
  const firstPageEntries = useMemo(
    () => (firstPage ? toGalleryBrowseEntries(firstPage) : []),
    [firstPage],
  );

  const entries = useMemo(
    () => dedupeEntries(firstPageEntries, accumulation.entries),
    [accumulation.entries, firstPageEntries],
  );
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

  // The next cursor is the last accumulated one; a refetched page 1 does not
  // rewind pagination.
  const cursor =
    accumulation.cursor ?? (firstPageIsCurrent ? (firstPage?.page.cursor ?? null) : null);
  const hasMore =
    accumulation.hasMore ?? (firstPageIsCurrent ? (firstPage?.page.hasMore ?? false) : false);
  const page: GalleryPageState = useMemo(
    () => ({ cursor, error: accumulation.error, hasMore, loading: accumulation.loading }),
    [accumulation.error, accumulation.loading, cursor, hasMore],
  );

  // Refs so awaited results never depend on a stale render.
  const liveRef = useRef({ browseKey, cursor, entries, hasMore, listingRequest, media });
  liveRef.current = { browseKey, cursor, entries, hasMore, listingRequest, media };

  const loadNextPage = useCallback((): Promise<LoadNextPageResult> => {
    const live = liveRef.current;
    const inFlight = inFlightRef.current;
    if (inFlight && inFlight.browseKey === live.browseKey) {
      return inFlight.promise;
    }
    if (!live.hasMore || !live.cursor) {
      return Promise.resolve({ appendedEntryKeys: [], appendedMediaIds: [], exhausted: true });
    }

    const key = live.browseKey;
    const requestCursor = live.cursor;
    updateAccumulation(key, (current) => ({ ...current, loading: true }));
    // The promise compares against its own identity in `finally`, so it is
    // assigned after construction and read through this binding.
    let ownPromise: Promise<LoadNextPageResult> | null = null;
    const promise = (async (): Promise<LoadNextPageResult> => {
      try {
        const next = await source.loadPage({ ...live.listingRequest, cursor: requestCursor });
        if (liveRef.current.browseKey !== key) {
          throw new StaleBrowseError();
        }
        if (next.page.hasMore && next.page.cursor === requestCursor) {
          throw new Error("Gallery listing cursor did not advance");
        }
        const nextEntries = toGalleryBrowseEntries(next);
        const known = new Set(liveRef.current.entries.map((entry) => entry.key));
        const appended = nextEntries.filter((entry) => !known.has(entry.key));
        updateAccumulation(key, (current) => ({
          ...current,
          cursor: next.page.cursor,
          entries: dedupeEntries(current.entries, nextEntries),
          error: null,
          hasMore: next.page.hasMore,
        }));
        return {
          appendedEntryKeys: appended.map((entry) => entry.key),
          appendedMediaIds: appended.flatMap((entry) => {
            const item = entryMedia(entry);
            return item ? [item.id] : [];
          }),
          exhausted: !next.page.hasMore,
        };
      } catch (error) {
        if (!(error instanceof StaleBrowseError)) {
          updateAccumulation(key, (current) => ({ ...current, error }));
        }
        throw error;
      } finally {
        if (inFlightRef.current?.promise === ownPromise) {
          inFlightRef.current = null;
        }
        updateAccumulation(key, (current) => ({ ...current, loading: false }));
      }
    })();
    ownPromise = promise;
    inFlightRef.current = { browseKey: key, promise };
    return promise;
  }, [source, updateAccumulation]);

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

  const showFetching = hydrated && (isSnapshotFetching || isListingFetching);
  // The grid is served entirely by the listing, folder tiles included; the
  // snapshot only feeds the sidebar and sibling-folder navigation. Waiting on
  // it here would hold every tile for the slower of the two requests.
  const isReady = Boolean(firstPage);

  return useMemo(
    () => ({
      allMedia,
      browseKey,
      entries,
      isReady,
      library,
      loadNextPage,
      media,
      openComic,
      page,
      showFetching,
      stepEntry,
      stepMedia,
    }),
    [
      allMedia,
      browseKey,
      entries,
      isReady,
      library,
      loadNextPage,
      media,
      openComic,
      page,
      showFetching,
      stepEntry,
      stepMedia,
    ],
  );
}
