import { describe, expect, it } from "vitest";
import {
  areThumbnailRequestsEqual,
  buildBrowseKey,
  dedupeThumbnailRequests,
} from "./gallery-page-helpers";

describe("dedupeThumbnailRequests", () => {
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

describe("buildBrowseKey", () => {
  it("changes when any population field changes and ignores nothing else", () => {
    const base = {
      comicMode: false,
      path: "videos",
      query: undefined,
      randomSeed: "00000000000000000000000000000007",
      recursive: false,
      showImages: true,
      showVideos: false,
      sortMode: "date-newest" as const,
    };
    expect(buildBrowseKey(base)).toBe(
      "videos||false|false|00000000000000000000000000000007|true|false|date-newest",
    );
    expect(buildBrowseKey({ ...base, randomSeed: "00000000000000000000000000000008" })).not.toBe(
      buildBrowseKey(base),
    );
    expect(buildBrowseKey({ ...base, comicMode: true })).not.toBe(buildBrowseKey(base));
    expect(buildBrowseKey({ ...base })).toBe(buildBrowseKey(base));
  });
});
