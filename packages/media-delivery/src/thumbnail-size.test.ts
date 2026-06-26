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
    expect(snapThumbnailSize(700)).toBe(720);
    expect(snapThumbnailSize(1000)).toBe(960);
  });

  it("defaults invalid sizes to the gallery thumbnail size", () => {
    expect(snapThumbnailSize(0)).toBe(720);
    expect(snapThumbnailSize(Number.NaN)).toBe(720);
  });

  it("exposes the ladder", () => {
    expect(THUMBNAIL_SIZE_LADDER).toEqual([160, 320, 480, 640, 720, 960, 1080]);
  });

  it("exposes fixed gallery and preview sizes", () => {
    expect(GALLERY_THUMBNAIL_SIZE).toBe(720);
    expect(PREVIEW_DERIVATIVE_SIZE).toBe(1080);
  });
});
