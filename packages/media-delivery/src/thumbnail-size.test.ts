import { describe, expect, it } from "vitest";
import { snapThumbnailSize, THUMBNAIL_SIZE_LADDER } from "./thumbnail-size.js";

describe("snapThumbnailSize", () => {
  it("snaps to the nearest ladder size", () => {
    expect(snapThumbnailSize(300)).toBe(320);
    expect(snapThumbnailSize(500)).toBe(480);
  });

  it("defaults invalid sizes to 320", () => {
    expect(snapThumbnailSize(0)).toBe(320);
    expect(snapThumbnailSize(Number.NaN)).toBe(320);
  });

  it("exposes the ladder", () => {
    expect(THUMBNAIL_SIZE_LADDER).toEqual([160, 320, 480, 640, 960]);
  });
});
