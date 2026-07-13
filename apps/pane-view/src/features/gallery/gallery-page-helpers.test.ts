import { describe, expect, it } from "vitest";
import { toLibrarySnapshotRequest } from "../library/library-queries";
import {
  areThumbnailRequestsEqual,
  dedupeThumbnailRequests,
  supportsGalleryThumbnail,
  toLibrarySnapshotNextPageRequest,
} from "./gallery-page-helpers";

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
