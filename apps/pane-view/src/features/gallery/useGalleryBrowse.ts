import type { BrowserEntry } from "@latch-works/media-domain";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  browsePageFromListingPage,
  browsePageFromMediaPage,
  buildBrowseKey,
  mediaPageFromBrowsePage,
  mergeLibraryMedia,
  resolveBrowseEntries,
  resolveBrowseMedia,
  toLibrarySnapshotNextPageRequest,
} from "@/features/gallery/gallery-page-helpers";
import {
  type GalleryListingQueryRequest,
  type LibrarySnapshotRequest,
  useGalleryListingQuery,
  useLibrarySnapshotQuery,
} from "@/features/library/library-queries";
import { getGalleryListing, getLibrarySnapshot } from "@/features/library/library-service";
import type { GalleryBrowsePage, LibraryMediaItem, MediaPage } from "@/features/library/types";

export interface UseGalleryBrowseOptions {
  displayPath: string;
  effectiveComicMode: boolean;
  effectiveRecursive: boolean;
  hydrated: boolean;
  listingRequest: GalleryListingQueryRequest;
  showImages: boolean;
  showVideos: boolean;
  snapshotRequest: LibrarySnapshotRequest;
}

/**
 * One browse model for comic and server listing.
 * Comic mode is a post-process of snapshot media pages; listing mode accumulates cursor pages.
 * Both share the same extraMedia / extraEntries / page / loadMore surface.
 */
export function useGalleryBrowse({
  displayPath,
  effectiveComicMode,
  effectiveRecursive,
  hydrated,
  listingRequest,
  showImages,
  showVideos,
  snapshotRequest,
}: UseGalleryBrowseOptions) {
  const [extraMedia, setExtraMedia] = useState<LibraryMediaItem[]>([]);
  const [extraEntries, setExtraEntries] = useState<BrowserEntry[]>([]);
  const [browsePage, setBrowsePage] = useState<GalleryBrowsePage | null>(null);
  const [loadingMoreMedia, setLoadingMoreMedia] = useState(false);

  const { data: library, isFetching } = useLibrarySnapshotQuery(snapshotRequest);
  const {
    data: listing,
    isFetching: isListingFetching,
    isPlaceholderData: isListingPlaceholderData,
  } = useGalleryListingQuery(listingRequest);

  const usesServerListing = !effectiveComicMode;
  const showFetching = hydrated && (isFetching || (usesServerListing && isListingFetching));

  const browseKey = useMemo(
    () =>
      buildBrowseKey({
        comicMode: effectiveComicMode,
        includeListingFields: usesServerListing,
        path: snapshotRequest.path ?? listingRequest.path,
        query: snapshotRequest.query ?? listingRequest.query,
        randomSeed: listingRequest.randomSeed,
        recursive: effectiveRecursive,
        showImages: listingRequest.showImages,
        showVideos: listingRequest.showVideos,
        sortMode: listingRequest.sortMode,
      }),
    [
      effectiveComicMode,
      effectiveRecursive,
      listingRequest.path,
      listingRequest.query,
      listingRequest.randomSeed,
      listingRequest.showImages,
      listingRequest.showVideos,
      listingRequest.sortMode,
      snapshotRequest.path,
      snapshotRequest.query,
      usesServerListing,
    ],
  );

  useEffect(() => {
    setExtraMedia([]);
    setExtraEntries([]);
    setBrowsePage(null);
    setLoadingMoreMedia(false);
  }, [browseKey]);

  useEffect(() => {
    if (!library || usesServerListing) {
      return;
    }

    setBrowsePage(browsePageFromMediaPage(library.mediaPage));
  }, [browseKey, library, usesServerListing]);

  useEffect(() => {
    if (!listing || !usesServerListing || isListingPlaceholderData) {
      return;
    }

    setBrowsePage(browsePageFromListingPage(listing.page));
  }, [browseKey, isListingPlaceholderData, listing, usesServerListing]);

  const allMedia = useMemo(() => {
    const base = effectiveComicMode ? (library?.media ?? []) : (listing?.media ?? []);
    return mergeLibraryMedia(base, extraMedia);
  }, [effectiveComicMode, extraMedia, library?.media, listing?.media]);

  const visibleMedia = useMemo(
    () =>
      resolveBrowseMedia({
        comicMode: effectiveComicMode,
        extraMedia,
        listingMedia: listing?.media,
        randomSeed: listingRequest.randomSeed,
        showImages,
        showVideos,
        snapshotMedia: library?.media,
        sortMode: listingRequest.sortMode,
      }),
    [
      effectiveComicMode,
      extraMedia,
      library?.media,
      listing?.media,
      listingRequest.randomSeed,
      listingRequest.sortMode,
      showImages,
      showVideos,
    ],
  );

  const entries = useMemo(
    () =>
      resolveBrowseEntries({
        allFolders: library?.allFolders,
        comicMode: effectiveComicMode,
        displayPath,
        extraEntries,
        folders: library?.folders,
        listingEntries: listing?.entries,
        randomSeed: listingRequest.randomSeed,
        recursive: effectiveRecursive,
        sortMode: listingRequest.sortMode,
        visibleMedia,
      }),
    [
      displayPath,
      effectiveComicMode,
      effectiveRecursive,
      extraEntries,
      library?.allFolders,
      library?.folders,
      listing?.entries,
      listingRequest.randomSeed,
      listingRequest.sortMode,
      visibleMedia,
    ],
  );

  const mediaPage: MediaPage | null = mediaPageFromBrowsePage(browsePage);

  const loadMoreMedia = useCallback(async () => {
    if (!browsePage?.hasMore || loadingMoreMedia) {
      return;
    }

    if (usesServerListing) {
      if (!browsePage.cursor) {
        return;
      }

      setLoadingMoreMedia(true);
      try {
        const nextListing = await getGalleryListing({
          data: {
            ...listingRequest,
            cursor: browsePage.cursor,
          },
        });
        setExtraMedia((current) => mergeLibraryMedia(current, nextListing.media));
        setExtraEntries((current) => [...current, ...nextListing.entries]);
        setBrowsePage(browsePageFromListingPage(nextListing.page));
      } finally {
        setLoadingMoreMedia(false);
      }
      return;
    }

    if (browsePage.nextOffset === null) {
      return;
    }

    setLoadingMoreMedia(true);
    try {
      const nextSnapshot = await getLibrarySnapshot({
        data: toLibrarySnapshotNextPageRequest(snapshotRequest, browsePage.nextOffset),
      });
      setExtraMedia((current) => mergeLibraryMedia(current, nextSnapshot.media));
      setBrowsePage(browsePageFromMediaPage(nextSnapshot.mediaPage));
    } finally {
      setLoadingMoreMedia(false);
    }
  }, [browsePage, listingRequest, loadingMoreMedia, snapshotRequest, usesServerListing]);

  const handleLoadMoreMedia = useCallback(() => {
    void loadMoreMedia();
  }, [loadMoreMedia]);

  const isReady = Boolean(library && (!usesServerListing || listing));

  return {
    allMedia,
    browseKey,
    entries,
    handleLoadMoreMedia,
    isReady,
    library,
    listing,
    loadingMoreMedia,
    mediaPage,
    showFetching,
    usesServerListing,
    visibleMedia,
  };
}
