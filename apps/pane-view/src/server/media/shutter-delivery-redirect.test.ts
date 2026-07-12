import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readContext: vi.fn(),
  resolveImage: vi.fn(),
  resolvePreview: vi.fn(),
}));

vi.mock("./repository", () => ({
  readMediaThumbnailContext: mocks.readContext,
}));
vi.mock("./shutter-client", () => ({
  resolveShutterImageUrl: mocks.resolveImage,
  resolveShutterPreview: mocks.resolvePreview,
}));

import { redirectToShutterRendition } from "./shutter-delivery-redirect";

const image = {
  extension: "jpg",
  mediaObjectId: "object-image",
  mediaType: "image" as const,
  originalObjectKey: "originals/image.jpg",
  sha256: "a".repeat(64),
};

describe("redirectToShutterRendition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readContext.mockResolvedValue(image);
    mocks.resolveImage.mockResolvedValue("https://edge.shutter.test/image");
    mocks.resolvePreview.mockResolvedValue({ status: "pending", retryAfterMs: 9_000 });
  });

  it("redirects image thumbnails through Shutter", async () => {
    const response = await redirectToShutterRendition({
      mediaId: "image",
      width: 320,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://edge.shutter.test/image");
    expect(mocks.resolveImage).toHaveBeenCalledWith(image, 320);
  });

  it("returns retryable 503 while video previews are pending", async () => {
    mocks.readContext.mockResolvedValue({
      ...image,
      extension: "mp4",
      mediaType: "video",
      originalObjectKey: "originals/video.mp4",
      sha256: "b".repeat(64),
    });

    const response = await redirectToShutterRendition({
      mediaId: "video",
      width: 640,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("9");
  });
});
