import { describe, expect, it } from "vitest";
import { areThumbnailRequestsEqual, dedupeThumbnailRequests } from "./gallery-page-helpers";

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
