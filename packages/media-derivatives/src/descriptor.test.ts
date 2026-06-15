import { describe, expect, it } from "vitest";
import { buildDerivativeDescriptor, supportsDerivative } from "./descriptor.js";

const sha256 = "a".repeat(64);

describe("supportsDerivative", () => {
  it("supports image, gif, and video", () => {
    expect(supportsDerivative("image")).toBe(true);
    expect(supportsDerivative("gif")).toBe(true);
    expect(supportsDerivative("video")).toBe(true);
  });

  it("rejects pdf and unknown", () => {
    expect(supportsDerivative("pdf")).toBe(false);
    expect(supportsDerivative("unknown")).toBe(false);
  });
});

describe("buildDerivativeDescriptor", () => {
  it("uses the thumbnail key for images", () => {
    const descriptor = buildDerivativeDescriptor(
      { extension: "jpg", mediaType: "image", sha256 },
      320,
    );

    expect(descriptor.purpose).toBe("thumbnail");
    expect(descriptor.objectKey).toContain("thumbnails/sha256/");
    expect(descriptor.objectKey).toContain("-320.webp");
  });

  it("uses the preview key for videos", () => {
    const descriptor = buildDerivativeDescriptor(
      { extension: "mp4", mediaType: "video", sha256 },
      320,
    );

    expect(descriptor.purpose).toBe("preview");
    expect(descriptor.objectKey).toContain("previews/video/sha256/");
  });
});
