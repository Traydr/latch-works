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
}

function emptyAccumulation(browseKey: string): Accumulation {
  return { browseKey, cursor: null, entries: [], error: null, hasMore: null };
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
  const [stored, setStored] = useState<Accumulation>(() => emptyAccumulation(browseKey));
  const accumulation = stored.browseKey === browseKey ? stored : emptyAccumulation(browseKey);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef<{ browseKey: string; promise: Promise<LoadNextPageResult> } | null>(
    null,
  );

  const updateAccumulation = useCallback(
    (key: string, update: (current: Accumulation) => Accumulation) => {
      setStored((current) => update(current.browseKey === key ? current : emptyAccumulation(key)));
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
      entries.flatMap((entry) =>
        entryMedia(entry) ? [entryMedia(entry) as LibraryMediaItem] : [],
      ),
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
    () => ({ cursor, error: accumulation.error, hasMore, loading }),
    [accumulation.error, cursor, hasMore, loading],
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
    setLoading(true);
    const ticket: { promise: Promise<LoadNextPageResult> | null } = { promise: null };
    const promise = (async (): Promise<LoadNextPageResult> => {
      try {
        const next = await source.loadPage({ ...live.listingRequest, cursor: requestCursor });
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
        updateAccumulation(key, (current) => ({ ...current, error }));
        throw error;
      } finally {
        if (inFlightRef.current?.promise === ticket.promise) {
          inFlightRef.current = null;
        }
        setLoading(false);
      }
    })();
    ticket.promise = promise;
    inFlightRef.current = { browseKey: key, promise };
    return promise;
  }, [source, updateAccumulation]);

  const stepMedia = useCallback(
    async (currentId: string | null, direction: -1 | 1, loop: boolean): Promise<string | null> => {
      const sequence = liveRef.current.media;
      const index = currentId ? sequence.findIndex((item) => item.id === currentId) : -1;
      if (direction === 1) {
        const next = sequence[index + 1];
        if (next) return next.id;
        if (liveRef.current.hasMore) {
          try {
            const result = await loadNextPage();
            const first = result.appendedMediaIds[0];
            if (first) return first;
            if (!result.exhausted) return null;
          } catch {
            return null;
          }
        }
        return loop && sequence.length > 0 && sequence[0]?.id !== currentId
          ? (sequence[0]?.id ?? null)
          : null;
      }
      if (index > 0) return sequence[index - 1]?.id ?? null;
      if (index < 0 && sequence.length > 0) return sequence[0]?.id ?? null;
      // Decision 7: no backward wrap while more pages exist.
      if (liveRef.current.hasMore) return null;
      const last = sequence.at(-1);
      return loop && last && last.id !== currentId ? last.id : null;
    },
    [loadNextPage],
  );

  const stepEntry = useCallback(
    async (currentKey: string | null, direction: -1 | 1, loop: boolean): Promise<string | null> => {
      const sequence = liveRef.current.entries;
      const index = currentKey ? sequence.findIndex((entry) => entry.key === currentKey) : -1;
      if (direction === 1) {
        const next = sequence[index + 1];
        if (next) return next.key;
        if (liveRef.current.hasMore) {
          try {
            const result = await loadNextPage();
            const first = result.appendedEntryKeys[0];
            if (first) return first;
            if (!result.exhausted) return null;
          } catch {
            return null;
          }
        }
        return loop && sequence.length > 0 && sequence[0]?.key !== currentKey
          ? (sequence[0]?.key ?? null)
          : null;
      }
      if (index > 0) return sequence[index - 1]?.key ?? null;
      if (index < 0 && sequence.length > 0) return sequence[0]?.key ?? null;
      if (liveRef.current.hasMore) return null;
      const last = sequence.at(-1);
      return loop && last && last.key !== currentKey ? last.key : null;
    },
    [loadNextPage],
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
  const isReady = Boolean(library && firstPage);

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
