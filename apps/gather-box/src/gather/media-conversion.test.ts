import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_AVIF_QUALITY,
  ARCHIVE_AVIF_SPEED,
  convertMediaForArchive,
  getMediaConversionPlan,
  type MediaConverters
} from "./media-conversion";

describe("archive media conversion", () => {
  it("uses the archive AVIF encoder settings", () => {
    expect({ quality: ARCHIVE_AVIF_QUALITY, speed: ARCHIVE_AVIF_SPEED }).toEqual({
      quality: 70,
      speed: 6
    });
  });

  it.each(["photo.jpg", "photo.jpeg", "photo.png", "photo.webp", "photo.bmp"])(
    "converts %s to an AVIF filename",
    (fileName) => {
      expect(getMediaConversionPlan(fileName, "application/octet-stream")).toEqual({
        kind: "avif",
        fileName: "photo.avif"
      });
    }
  );

  it("converts GIF filenames to MP4", () => {
    expect(getMediaConversionPlan("animation.GIF", "image/gif")).toEqual({
      kind: "gif-to-mp4",
      fileName: "animation.mp4"
    });
  });

  it("passes existing AVIF and MP4 files through", () => {
    expect(getMediaConversionPlan("photo.avif", "image/avif")).toBeNull();
    expect(getMediaConversionPlan("animation.mp4", "video/mp4")).toBeNull();
  });

  it("leaves videos, PDFs, and unknown attachments unchanged", () => {
    expect(getMediaConversionPlan("clip.webm", "video/webm")).toBeNull();
    expect(getMediaConversionPlan("story.pdf", "application/pdf")).toBeNull();
    expect(getMediaConversionPlan("archive.zip", "application/zip")).toBeNull();
  });

  it("encodes a still image and returns the converted blob and filename", async () => {
    const converters = createConverters();

    const result = await convertMediaForArchive(
      new Blob(["png"], { type: "image/png" }),
      "page.png",
      undefined,
      converters
    );

    expect(converters.encodeStillAsAvif).toHaveBeenCalledOnce();
    expect(converters.encodeGifAsMp4).not.toHaveBeenCalled();
    expect(result.fileName).toBe("page.avif");
    expect(result.blob.type).toBe("image/avif");
    expect(result.converted).toBe(true);
  });

  it("encodes a GIF as an MP4", async () => {
    const converters = createConverters();

    const result = await convertMediaForArchive(
      new Blob(["gif"], { type: "image/gif" }),
      "loop.gif",
      undefined,
      converters
    );

    expect(converters.encodeGifAsMp4).toHaveBeenCalledOnce();
    expect(converters.encodeStillAsAvif).not.toHaveBeenCalled();
    expect(result.fileName).toBe("loop.mp4");
    expect(result.blob.type).toBe("video/mp4");
    expect(result.converted).toBe(true);
  });
});

function createConverters(): MediaConverters {
  return {
    encodeStillAsAvif: vi.fn(async () => new TextEncoder().encode("avif").buffer),
    encodeGifAsMp4: vi.fn(async () => new TextEncoder().encode("mp4").buffer)
  };
}
