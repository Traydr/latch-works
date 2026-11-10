// @vitest-environment jsdom
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { galleryListingKeys } from "@/features/library/library-queries";
import type {
  GalleryComic,
  GalleryListingPage,
  GalleryListingRequest,
  GalleryMedia,
  LibrarySnapshotRequest,
} from "@/features/library/listing-contract";
import type { GalleryPageSource } from "./gallery-page-source";
import { type GalleryBrowseSession, useGalleryBrowse } from "./useGalleryBrowse";

const PAGE_SIZE = 2;

const listingRequest: GalleryListingRequest = {
  comicMode: false,
  excludedPaths: [],
  limit: PAGE_SIZE,
  path: "photos",
  query: undefined,
  randomSeed: "0123456789abcdef0123456789abcdef",
  recursive: false,
  showImages: true,
  showVideos: true,
  sortMode: "name-asc",
};

const snapshotRequest: LibrarySnapshotRequest = {
  includeAllFolders: false,
  path: "photos",
  query: undefined,
};

function mediaItem(id: string, sha256 = `sha-${id}`): GalleryMedia {
  return {
    extension: "jpg",
    id,
    mediaType: "image",
    mtimeMs: 0,
    name: `${id}.jpg`,
    parentPath: "photos",
    path: `photos/${id}.jpg`,
    sha256,
    size: 1,
  };
}

interface HeldRead {
  cursor: string | null;
  release(): void;
}

interface Archive {
  comicPageHash: string;
  held: HeldRead[];
  holding: boolean;
  ids: string[];
}

/**
 * An archive listed two items per page with offset cursors. A read sees the
 * archive as it is when the request is made, or, while `holding`, waits in
 * `held` and sees it as it is when the test releases it, which is how the
 * tests order overlapping requests.
 */
function createArchive(initialIds: readonly string[]) {
  const archive: Archive = {
    comicPageHash: "sha-page-old",
    held: [],
    holding: false,
    ids: [...initialIds],
  };

  const source: GalleryPageSource = {
    loadComic: (request): Promise<GalleryComic> => {
      const page = mediaItem("page-1", archive.comicPageHash);

      return Promise.resolve({
        cover: page,
        folderPath: request.comicId,
        id: request.comicId,
        name: request.comicId,
        pages: [page],
      });
    },
    loadPage: (_request, cursor): Promise<GalleryListingPage> => {
      const read = (): GalleryListingPage => {
        const start = cursor ? Number(cursor) : 0;
        const ids = archive.ids.slice(start, start + PAGE_SIZE);
        const hasMore = start + PAGE_SIZE < archive.ids.length;

        return {
          entries: ids.map((id) => ({ key: `media:${id}`, kind: "media", media: mediaItem(id) })),
          page: { cursor: hasMore ? String(start + PAGE_SIZE) : null, hasMore, limit: PAGE_SIZE },
          subjectKind: "media",
        };
      };

      if (!archive.holding) {
        return Promise.resolve(read());
      }

      return new Promise((resolve) => {
        archive.held.push({ cursor, release: () => resolve(read()) });
      });
    },
  };

  return { archive, source };
}

/** Releases the oldest held read of `cursor` once it has been made. */
async function release(archive: Archive, cursor: string | null) {
  await vi.waitFor(() => expect(archive.held.some((read) => read.cursor === cursor)).toBe(true));
  const index = archive.held.findIndex((read) => read.cursor === cursor);
  archive.held.splice(index, 1)[0]?.release();
}

const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  focusManager.setFocused(undefined);
});

async function mountBrowse(source: GalleryPageSource) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let session: GalleryBrowseSession | null = null;

  function Probe() {
    session = useGalleryBrowse({ hydrated: true, listingRequest, snapshotRequest, source });

    return null;
  }

  const root = createRoot(document.createElement("div"));
  root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  unmounts.push(() => root.unmount());

  const current = (): GalleryBrowseSession => {
    if (!session) throw new Error("useGalleryBrowse has not rendered");

    return session;
  };

  await vi.waitFor(() => expect(current().isReady).toBe(true));

  return Object.assign(current, { client });
}

function ids(session: GalleryBrowseSession): string[] {
  return session.media.map((item) => item.id);
}

describe("useGalleryBrowse refresh", () => {
  it("re-reads every loaded page from a fresh page 1", async () => {
    const { archive, source } = createArchive(["a", "b", "c", "d", "e"]);
    const session = await mountBrowse(source);
    await session().loadNextPage();
    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "b", "c", "d"]));

    archive.ids = ["a", "aa", "b", "c", "d", "e"];
    await session().refresh();

    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "aa", "b", "c"]));
    await session().loadNextPage();
    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "aa", "b", "c", "d", "e"]));
  });

  it("keeps a next page that finishes while Refresh waits for it", async () => {
    const { archive, source } = createArchive(["a", "b", "c", "d", "e"]);
    const session = await mountBrowse(source);

    archive.holding = true;
    const loading = session().loadNextPage();
    await vi.waitFor(() => expect(archive.held).toHaveLength(1));
    const refreshing = session().refresh();
    await release(archive, "2");
    archive.holding = false;
    await Promise.all([loading, refreshing]);

    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "b", "c", "d"]));
  });

  it("does not let a focus refetch overwrite a Refresh that is running", async () => {
    const { archive, source } = createArchive(["a", "b", "c", "d", "e"]);
    const session = await mountBrowse(source);
    await session().loadNextPage();
    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "b", "c", "d"]));

    archive.ids = ["a", "aa", "b", "c", "d", "e"];
    archive.holding = true;
    const refreshing = session().refresh();
    await vi.waitFor(() => expect(archive.held).toHaveLength(1));

    // A focus refetch made now, if one is made at all, waits behind the
    // Refresh's reads and answers last, with a read from before the sync
    // landed.
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await release(archive, null);
    await release(archive, "2");
    await refreshing;
    archive.ids = ["a", "b", "c", "d", "e"];
    archive.holding = false;

    for (const read of archive.held.splice(0)) read.release();

    await vi.waitFor(() =>
      expect(session.client.isFetching({ queryKey: galleryListingKeys.all })).toBe(0),
    );
    archive.ids = ["a", "aa", "b", "c", "d", "e"];

    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "aa", "b", "c"]));
    expect(session().page.hasMore).toBe(true);
    await session().loadNextPage();
    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "aa", "b", "c", "d", "e"]));
  });

  it("pages from the refreshed listing when Load more is pressed during Refresh", async () => {
    const { archive, source } = createArchive(["a", "b", "c", "d", "e"]);
    const session = await mountBrowse(source);

    archive.ids = ["a", "aa", "b", "c", "d", "e"];
    archive.holding = true;
    const refreshing = session().refresh();
    const loading = session().loadNextPage();
    await release(archive, null);
    archive.holding = false;
    const result = await loading;
    await refreshing;

    expect(result.appendedMediaIds).toEqual(["b", "c"]);
    await vi.waitFor(() => expect(ids(session())).toEqual(["a", "aa", "b", "c"]));
  });

  it("reopens a comic with the page metadata Refresh found", async () => {
    const { archive, source } = createArchive(["a", "b"]);
    const session = await mountBrowse(source);

    const before = await session().openComic("photos/comic");
    expect(before.pages[0]?.sha256).toBe("sha-page-old");

    archive.comicPageHash = "sha-page-new";
    await session().refresh();
    const after = await session().openComic("photos/comic");

    expect(after.pages[0]?.sha256).toBe("sha-page-new");
  });
});

describe("useGalleryBrowse paging", () => {
  it("steps onto a page another load added before the grid rendered it", async () => {
    const { source } = createArchive(["a", "b", "c", "d", "e"]);
    const session = await mountBrowse(source);
    const rendered = session();

    // Infinite scroll loads page 2; the viewer steps past "b" before the
    // render that shows it.
    await rendered.loadNextPage();

    expect(await rendered.stepMedia("b", 1, false)).toBe("c");
  });
});
