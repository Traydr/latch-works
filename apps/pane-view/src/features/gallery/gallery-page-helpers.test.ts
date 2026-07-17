import type { BrowserEntry, FolderNode } from "@latch-works/media-domain";
import { describe, expect, it } from "vitest";
import { toLibrarySnapshotRequest } from "../library/library-queries";
import type { LibraryMediaItem } from "../library/types";
import {
  areThumbnailRequestsEqual,
  browsePageFromListingPage,
  browsePageFromMediaPage,
  buildBrowseKey,
  dedupeThumbnailRequests,
  filterMediaByVisibility,
  mediaPageFromBrowsePage,
  mergeLibraryMedia,
  resolveBrowseEntries,
  resolveBrowseMedia,
  supportsGalleryThumbnail,
  toLibrarySnapshotNextPageRequest,
} from "./gallery-page-helpers";

function media(
  partial: Pick<LibraryMediaItem, "id" | "mediaType"> & Partial<LibraryMediaItem>,
): LibraryMediaItem {
  return {
    extension: "jpg",
    mtimeMs: 0,
    name: partial.name ?? partial.id,
    parentPath: "",
    path: partial.path ?? `${partial.id}.jpg`,
    size: 1,
    ...partial,
  } as LibraryMediaItem;
}

describe("supportsGalleryThumbnail", () => {
  it("returns true for image, gif, video, and pdf", () => {
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "image" } as never)).toBe(true);
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "gif" } as never)).toBe(true);
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "video" } as never)).toBe(true);
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "pdf" } as never)).toBe(true);
  });

  it("returns false for other media types", () => {
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "unknown" } as never)).toBe(false);
    expect(supportsGalleryThumbnail({ id: "1", mediaType: "audio" } as never)).toBe(false);
  });
});

describe("dedupeThumbnailRequests", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeThumbnailRequests([])).toEqual([]);
  });

  it("passes through requests with distinct mediaIds", () => {
    const requests = [{ mediaId: "a" }, { mediaId: "b" }, { mediaId: "c" }];
    expect(dedupeThumbnailRequests(requests)).toEqual(requests);
  });

  it("removes duplicate mediaId entries, keeping the first", () => {
    const requests = [{ mediaId: "a" }, { mediaId: "a" }, { mediaId: "b" }];
    expect(dedupeThumbnailRequests(requests)).toEqual([{ mediaId: "a" }, { mediaId: "b" }]);
  });

  it("treats same mediaId with different sizes as distinct keys", () => {
    const requests = [
      { mediaId: "a", size: 200 },
      { mediaId: "a", size: 400 },
    ];
    expect(dedupeThumbnailRequests(requests)).toEqual(requests);
  });

  it("treats explicit size=undefined and no size as the same key", () => {
    const requests = [{ mediaId: "a" }, { mediaId: "a", size: undefined }];
    expect(dedupeThumbnailRequests(requests)).toEqual([{ mediaId: "a" }]);
  });
});

describe("areThumbnailRequestsEqual", () => {
  it("returns true for two empty arrays", () => {
    expect(areThumbnailRequestsEqual([], [])).toBe(true);
  });

  it("returns false when lengths differ", () => {
    expect(areThumbnailRequestsEqual([{ mediaId: "a" }], [])).toBe(false);
  });

  it("returns true for identical request lists", () => {
    const list = [{ mediaId: "a" }, { mediaId: "b", size: 300 }];
    expect(areThumbnailRequestsEqual(list, list)).toBe(true);
  });

  it("returns false when mediaId differs at same position", () => {
    expect(areThumbnailRequestsEqual([{ mediaId: "a" }], [{ mediaId: "b" }])).toBe(false);
  });

  it("returns false when size differs at same position", () => {
    expect(
      areThumbnailRequestsEqual([{ mediaId: "a", size: 200 }], [{ mediaId: "a", size: 400 }]),
    ).toBe(false);
  });

  it("returns true for structurally equal but distinct array instances", () => {
    const left = [{ mediaId: "x", size: 100 }, { mediaId: "y" }];
    const right = [{ mediaId: "x", size: 100 }, { mediaId: "y" }];
    expect(areThumbnailRequestsEqual(left, right)).toBe(true);
  });
});

describe("toLibrarySnapshotNextPageRequest", () => {
  it("preserves each browse key while omitting all folders on later pages", () => {
    const photos = toLibrarySnapshotRequest({
      comic: true,
      path: "photos",
      q: "cover",
      recursive: true,
    });
    const videos = toLibrarySnapshotRequest({
      comic: false,
      path: "videos",
      q: "trailer",
      recursive: false,
    });

    expect(videos).not.toEqual(photos);
    expect(toLibrarySnapshotNextPageRequest(photos, 500)).toEqual({
      comicMode: true,
      includeAllFolders: false,
      mediaOffset: 500,
      path: "photos",
      query: "cover",
      recursive: true,
    });
    expect(toLibrarySnapshotNextPageRequest(videos, 500)).toEqual({
      comicMode: false,
      includeAllFolders: false,
      mediaOffset: 500,
      path: "videos",
      query: "trailer",
      recursive: false,
    });
  });
});

describe("mergeLibraryMedia", () => {
  it("appends only unseen load-more items", () => {
    const base = [media({ id: "a", mediaType: "image" }), media({ id: "b", mediaType: "image" })];
    const extra = [media({ id: "b", mediaType: "image" }), media({ id: "c", mediaType: "image" })];

    expect(mergeLibraryMedia(base, extra).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("browse page adapters", () => {
  it("maps snapshot MediaPage into unified browse page", () => {
    expect(
      browsePageFromMediaPage({
        hasMore: true,
        limit: 500,
        nextOffset: 500,
        offset: 0,
      }),
    ).toEqual({
      cursor: null,
      hasMore: true,
      limit: 500,
      nextOffset: 500,
    });
  });

  it("maps listing cursor page into unified browse page", () => {
    expect(
      browsePageFromListingPage({
        cursor: "abc",
        hasMore: true,
        limit: 60,
      }),
    ).toEqual({
      cursor: "abc",
      hasMore: true,
      limit: 60,
      nextOffset: null,
    });
  });

  it("round-trips browse page into MediaPage for the browse pane", () => {
    const browse = browsePageFromListingPage({ cursor: "x", hasMore: false, limit: 60 });
    expect(mediaPageFromBrowsePage(browse)).toEqual({
      hasMore: false,
      limit: 60,
      nextOffset: null,
      offset: 0,
    });
    expect(mediaPageFromBrowsePage(null)).toBeNull();
  });
});

describe("buildBrowseKey", () => {
  it("omits listing-only fields for comic/snapshot browse", () => {
    expect(
      buildBrowseKey({
        comicMode: true,
        includeListingFields: false,
        path: "photos",
        query: "cover",
        recursive: true,
        randomSeed: 99,
        showImages: false,
        showVideos: false,
        sortMode: "random",
      }),
    ).toBe("photos|cover|true|true");
  });

  it("includes sort and filter seed fields for server listing browse", () => {
    expect(
      buildBrowseKey({
        comicMode: false,
        includeListingFields: true,
        path: "videos",
        query: undefined,
        recursive: false,
        randomSeed: 7,
        showImages: true,
        showVideos: false,
        sortMode: "date-newest",
      }),
    ).toBe("videos||false|false|7|true|false|date-newest");
  });
});

describe("resolveBrowseMedia", () => {
  const listing = [media({ id: "l1", mediaType: "image" })];
  const snapshot = [
    media({ id: "s1", mediaType: "image" }),
    media({ id: "s2", mediaType: "video" }),
  ];
  const extra = [media({ id: "e1", mediaType: "image" })];

  it("merges listing media with extras without client re-sort", () => {
    const resolved = resolveBrowseMedia({
      comicMode: false,
      extraMedia: extra,
      listingMedia: listing,
      randomSeed: 1,
      showImages: true,
      showVideos: true,
      snapshotMedia: snapshot,
      sortMode: "name-asc",
    });

    expect(resolved.map((item) => item.id)).toEqual(["l1", "e1"]);
  });

  it("post-processes snapshot media for comic mode with visibility filters", () => {
    const resolved = resolveBrowseMedia({
      comicMode: true,
      extraMedia: extra,
      listingMedia: listing,
      randomSeed: 1,
      showImages: true,
      showVideos: false,
      snapshotMedia: snapshot,
      sortMode: "name-asc",
    });

    expect(resolved.map((item) => item.id)).toEqual(["e1", "s1"]);
  });
});

describe("resolveBrowseEntries", () => {
  it("appends listing extras onto the server listing page", () => {
    const listingEntries = [
      {
        key: "media:a",
        kind: "media",
        media: media({ id: "a", mediaType: "image" }),
        mediaIndex: 0,
      },
    ] as BrowserEntry[];
    const extraEntries = [
      {
        key: "media:b",
        kind: "media",
        media: media({ id: "b", mediaType: "image" }),
        mediaIndex: 1,
      },
    ] as BrowserEntry[];

    const entries = resolveBrowseEntries({
      allFolders: [],
      comicMode: false,
      displayPath: "photos",
      extraEntries,
      folders: [],
      listingEntries,
      randomSeed: 1,
      recursive: false,
      sortMode: "name-asc",
      visibleMedia: [],
    });

    expect(entries.map((entry) => entry.key)).toEqual(["media:a", "media:b"]);
  });

  it("builds comic-mode entries as a post-process of the same media page", () => {
    const folders = [
      {
        name: "chapter-1",
        path: "comics/chapter-1",
        parentPath: "comics",
        hasChildren: false,
        mediaCount: 2,
        folderCount: 0,
      },
    ] as FolderNode[];
    const visibleMedia = [
      media({
        id: "c1",
        mediaType: "image",
        name: "001.jpg",
        path: "comics/chapter-1/001.jpg",
        parentPath: "comics/chapter-1",
      }),
      media({
        id: "c2",
        mediaType: "image",
        name: "002.jpg",
        path: "comics/chapter-1/002.jpg",
        parentPath: "comics/chapter-1",
      }),
    ];

    const entries = resolveBrowseEntries({
      allFolders: folders,
      comicMode: true,
      displayPath: "comics",
      extraEntries: [],
      folders,
      listingEntries: [],
      randomSeed: 1,
      recursive: true,
      sortMode: "name-asc",
      visibleMedia,
    });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.kind === "comic" || entry.kind === "media")).toBe(true);
  });
});

describe("filterMediaByVisibility", () => {
  it("drops videos when showVideos is false", () => {
    const items = [media({ id: "i", mediaType: "image" }), media({ id: "v", mediaType: "video" })];
    expect(
      filterMediaByVisibility(items, { showImages: true, showVideos: false }).map(
        (item) => item.id,
      ),
    ).toEqual(["i"]);
  });
});
