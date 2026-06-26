import { describe, expect, it } from "vitest";
import {
  buildDerivativeDescriptor,
  supportsDerivative,
  supportsInlineImageThumbnail,
} from "./descriptor.js";

const sha256 = "a".repeat(64);

describe("supportsDerivative", () => {
  it("returns true for image, gif, and video", () => {
    expect(supportsDerivative("video")).toBe(true);
    expect(supportsDerivative("image")).toBe(true);
    expect(supportsDerivative("gif")).toBe(true);
    expect(supportsDerivative("pdf")).toBe(false);
    expect(supportsDerivative("unknown")).toBe(false);
  });
});

describe("supportsInlineImageThumbnail", () => {
  it("returns true for image and gif", () => {
    expect(supportsInlineImageThumbnail("image")).toBe(true);
    expect(supportsInlineImageThumbnail("gif")).toBe(true);
    expect(supportsInlineImageThumbnail("video")).toBe(false);
  });
});

describe("buildDerivativeDescriptor", () => {
  it("builds a video preview descriptor", () => {
    const descriptor = buildDerivativeDescriptor(
      {
        extension: "mp4",
        mediaType: "video",
        sha256,
      },
      320,
    );

    expect(descriptor.purpose).toBe("preview");
    expect(descriptor.objectKey).toContain("previews/video/");
  });

  it("builds an image thumbnail descriptor", () => {
    const descriptor = buildDerivativeDescriptor(
      {
        extension: "jpg",
        mediaType: "image",
        sha256,
      },
      320,
    );

    expect(descriptor.purpose).toBe("thumbnail");
    expect(descriptor.objectKey).toContain("thumbnails/");
  });
});
