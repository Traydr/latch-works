import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GalleryPageSource } from "@/features/gallery/gallery-page-source";
import { type GalleryBrowseSession, useGalleryBrowse } from "@/features/gallery/useGalleryBrowse";
import type {
  GalleryListingQueryRequest,
  LibrarySnapshotRequest,
} from "@/features/library/library-queries";
import type { LibraryMediaItem } from "@/features/library/types";
import type { GalleryComicSummary } from "../../server/library/gallery-listing";

/**
 * Test-only. Renders useGalleryBrowse under a QueryClientProvider with an
 * injected page source and exposes the latest session plus rerender/flush
 * helpers. Tests observe the session through its interface only.
 */

export const SEED_A = "0123456789abcdef0123456789abcdef";
export const SEED_B = "fedcba9876543210fedcba9876543210";

export function mediaItem(id: string, overrides: Partial<LibraryMediaItem> = {}): LibraryMediaItem {
  return {
    extension: "jpg",
    id,
    mediaType: "image",
    mtimeMs: 1_700_000_000_000,
    name: `${id}.jpg`,
    parentPath: "photos",
    path: `photos/${id}.jpg`,
    size: 1000,
    ...overrides,
  };
}

export function comicSummary(folderPath: string, pageCount = 3): GalleryComicSummary {
  const name = folderPath.slice(folderPath.lastIndexOf("/") + 1);
  return {
    cover: mediaItem(`${name}-cover`, { parentPath: folderPath, path: `${folderPath}/001.jpg` }),
    folderPath,
    id: folderPath,
    name,
    pageCount,
  };
}

export function listingRequest(
  overrides: Partial<GalleryListingQueryRequest> = {},
): GalleryListingQueryRequest {
  return {
    comicMode: false,
    limit: 7,
    path: "photos",
    query: undefined,
    randomSeed: SEED_A,
    recursive: false,
    showImages: true,
    showVideos: true,
    sortMode: "name-asc",
    ...overrides,
  };
}

export function snapshotRequestFor(request: GalleryListingQueryRequest): LibrarySnapshotRequest {
  return {
    comicMode: request.comicMode,
    mediaLimit: 0,
    path: request.path,
    query: request.query,
    recursive: request.recursive,
  };
}

/** A snapshot payload with folders only, matching mediaLimit: 0. */
export function stubSnapshot() {
  return {
    allFolders: [],
    archiveRoot: "Synced archive",
    currentPath: "photos",
    folders: [],
    media: [],
    mediaPage: { hasMore: false, limit: 0, nextOffset: null, offset: 0 },
    mediaUrlMode: "signed-url" as const,
    roots: ["photos"],
  };
}

export interface HarnessOptions {
  excludedMediaIds?: ReadonlySet<string>;
  request: GalleryListingQueryRequest;
  /** Defaults to true. Set false to render a session that has no snapshot yet. */
  seedSnapshot?: boolean;
  source: GalleryPageSource;
}

export interface SessionHarness {
  flush(): Promise<void>;
  queryClient: QueryClient;
  rerender(next: Partial<HarnessOptions>): Promise<void>;
  readonly session: GalleryBrowseSession;
  unmount(): void;
}

export async function renderSession(initial: HarnessOptions): Promise<SessionHarness> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  // Seed the snapshot so the sidebar data is present without a snapshot
  // server. Readiness comes from the listing, so a session left unseeded is a
  // faithful "listing arrived, snapshot has not" render.
  const seedSnapshot = (request: GalleryListingQueryRequest) => {
    if (initial.seedSnapshot === false) return;
    queryClient.setQueryData(["library-snapshot", snapshotRequestFor(request)], stubSnapshot());
  };
  seedSnapshot(initial.request);

  let options = initial;
  let latest: GalleryBrowseSession | null = null;

  function Host(): ReactNode {
    latest = useGalleryBrowse({
      excludedMediaIds: options.excludedMediaIds,
      hydrated: true,
      listingRequest: options.request,
      snapshotRequest: snapshotRequestFor(options.request),
      source: options.source,
    });
    return null;
  }

  const container = document.createElement("div");
  let root: Root | null = null;
  const render = () =>
    act(() => {
      root ??= createRoot(container);
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Host)));
    });

  const flush = async () => {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  render();
  await flush();

  return {
    flush,
    queryClient,
    async rerender(next) {
      options = { ...options, ...next };
      seedSnapshot(options.request);
      render();
      await flush();
    },
    get session() {
      if (!latest) throw new Error("session not rendered");
      return latest;
    },
    unmount() {
      act(() => root?.unmount());
    },
  };
}

export function scriptedMedia(count: number, prefix = "m"): LibraryMediaItem[] {
  return Array.from({ length: count }, (_, index) =>
    mediaItem(`${prefix}-${String(index).padStart(3, "0")}`),
  );
}

export function scriptedComics(count: number, prefix = "photos/comic"): GalleryComicSummary[] {
  return Array.from({ length: count }, (_, index) =>
    comicSummary(`${prefix}-${String(index).padStart(3, "0")}`),
  );
}
