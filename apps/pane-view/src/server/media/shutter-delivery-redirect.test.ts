import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaThumbnailContext } from "./repository";
import {
  redirectToMediaVariant,
  type ShutterRedirectDependencies,
} from "./shutter-delivery-redirect";

const readThumbnailContext = vi.fn();
const resolveImageUrl = vi.fn();
const resolvePreview = vi.fn();

const dependencies: ShutterRedirectDependencies = {
  readThumbnailContext,
  resolveImageUrl,
  resolvePreview,
};

const image: MediaThumbnailContext = {
  extension: "jpg",
  mediaObjectId: "object-image",
  mediaType: "image",
  originalObjectKey: "originals/image.jpg",
  sha256: "a".repeat(64),
};

const video: MediaThumbnailContext = {
  ...image,
  extension: "mp4",
  mediaType: "video",
  originalObjectKey: "originals/video.mp4",
  sha256: "b".repeat(64),
};

describe("redirectToMediaVariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readThumbnailContext.mockResolvedValue(image);
    resolveImageUrl.mockResolvedValue("https://edge.shutter.test/image");
    resolvePreview.mockResolvedValue({ status: "pending", retryAfterMs: 9_000 });
  });

  it("redirects image thumbnails through Shutter", async () => {
    const response = await redirectToMediaVariant({ mediaId: "image", width: 320 }, dependencies);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://edge.shutter.test/image");
    expect(resolveImageUrl).toHaveBeenCalledWith(image, 320);
  });

  it("returns 502 when preview issuance fails", async () => {
    readThumbnailContext.mockResolvedValue(video);
    resolvePreview.mockRejectedValue(new Error("Shutter capability key ID is not active"));

    const response = await redirectToMediaVariant({ mediaId: "video", width: 640 }, dependencies);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Preview unavailable");
  });

  it("returns retryable 503 while video previews are pending", async () => {
    readThumbnailContext.mockResolvedValue(video);

    const response = await redirectToMediaVariant({ mediaId: "video", width: 640 }, dependencies);

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("9");
  });
});
