import { describe, expect, it } from "vitest";
import { getExpectedArchiveTarget, planArchiveMedia } from "./archive-media-policy";

describe("archive media policy", () => {
  it.each(["photo.jpg", "photo.jpeg", "photo.png", "photo.webp", "photo.bmp"])(
    "expects %s to use an AVIF target",
    (fileName) => {
      expect(getExpectedArchiveTarget(fileName)).toBe("photo.avif");
      expect(planArchiveMedia(fileName, "application/octet-stream")).toEqual({
        action: "convert-avif",
        fileName: "photo.avif"
      });
    }
  );

  it("expects a GIF filename to use an MP4 target", () => {
    expect(getExpectedArchiveTarget("animation.GIF")).toBe("animation.mp4");
    expect(planArchiveMedia("animation.GIF", "image/gif")).toEqual({
      action: "convert-mp4",
      fileName: "animation.mp4"
    });
  });

  it("uses the response MIME type for the final plan", () => {
    expect(getExpectedArchiveTarget("asset.jpg")).toBe("asset.avif");
    expect(planArchiveMedia("asset.jpg", "image/gif")).toEqual({
      action: "convert-mp4",
      fileName: "asset.mp4"
    });

    expect(getExpectedArchiveTarget("asset.bin")).toBeNull();
    expect(planArchiveMedia("asset.bin", "image/png")).toEqual({
      action: "convert-avif",
      fileName: "asset.avif"
    });
  });

  it("passes existing AVIF and MP4 files through", () => {
    expect(planArchiveMedia("photo.avif", "image/avif")).toBeNull();
    expect(planArchiveMedia("animation.mp4", "video/mp4")).toBeNull();
  });

  it("renames AVIF and MP4 responses that have stale filenames", () => {
    expect(planArchiveMedia("photo.jpg", "image/avif")).toEqual({
      action: "rename-avif",
      fileName: "photo.avif"
    });
    expect(planArchiveMedia("animation.gif", "video/mp4")).toEqual({
      action: "rename-mp4",
      fileName: "animation.mp4"
    });
  });

  it("leaves videos, PDFs, SVGs, and unknown attachments unchanged", () => {
    expect(planArchiveMedia("clip.webm", "video/webm")).toBeNull();
    expect(planArchiveMedia("story.pdf", "application/pdf")).toBeNull();
    expect(planArchiveMedia("vector.svg", "image/svg+xml")).toBeNull();
    expect(planArchiveMedia("archive.zip", "application/zip")).toBeNull();
  });
});
