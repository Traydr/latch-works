import { describe, expect, it } from "vitest";
import {
  GALLERY_THUMBNAIL_SIZE,
  PREVIEW_DERIVATIVE_SIZE,
  snapThumbnailSize,
  THUMBNAIL_SIZE_LADDER,
} from "./thumbnail-size.js";

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

  it("exposes fixed gallery and preview sizes", () => {
    expect(GALLERY_THUMBNAIL_SIZE).toBe(320);
    expect(PREVIEW_DERIVATIVE_SIZE).toBe(960);
  });
});
