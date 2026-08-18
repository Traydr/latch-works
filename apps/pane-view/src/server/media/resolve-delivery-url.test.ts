import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type MediaDeliveryDependencies,
  resolveMediaDeliveryUrlsForVariants,
} from "./resolve-delivery-url";

const readContexts = vi.fn();
const resolveImage = vi.fn();
const resolvePreview = vi.fn();

/** Nothing outside the batch logic runs: the archive and Shutter both stand in. */
const dependencies: MediaDeliveryDependencies = {
  createSignedOriginalUrl: async () => "https://storage.test/original?signature=test",
  readDeliveryRequest: async () => null,
  readThumbnailContext: async () => null,
  readThumbnailContexts: readContexts,
  resolveImageUrl: resolveImage,
  resolvePreview,
};

const image = {
  extension: "jpg",
  mediaObjectId: "object-image",
  mediaType: "image" as const,
  originalObjectKey: "originals/image.jpg",
  sha256: "a".repeat(64),
};
const video = {
  extension: "mp4",
  mediaObjectId: "object-video",
  mediaType: "video" as const,
  originalObjectKey: "originals/video.mp4",
  sha256: "b".repeat(64),
};

describe("resolveMediaDeliveryUrlsForVariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readContexts.mockResolvedValue(
      new Map<string, typeof image | typeof video>([
        ["image", image],
        ["video", video],
      ]),
    );
    resolveImage.mockResolvedValue("https://edge.shutter.test/image");
    resolvePreview.mockResolvedValue({
      status: "ready",
      url: "https://edge.shutter.test/master",
    });
  });

  it("deduplicates and returns private Shutter image URLs", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants(
      [
        { mediaId: "image", size: 321, variant: "thumbnail" },
        { mediaId: "image", size: 321, variant: "thumbnail" },
      ],
      dependencies,
    );
    expect(results).toEqual([
      {
        mediaId: "image",
        size: 321,
        status: "ready",
        url: "https://edge.shutter.test/image",
        variant: "thumbnail",
      },
    ]);
    expect(resolveImage).toHaveBeenCalledWith(image, 321);
    expect(resolvePreview).not.toHaveBeenCalled();
  });

  it("returns pending until video renditions are ready", async () => {
    resolvePreview.mockResolvedValueOnce({ status: "pending", retryAfterMs: 5_000 });
    await expect(
      resolveMediaDeliveryUrlsForVariants(
        [{ mediaId: "video", size: 640, variant: "preview" }],
        dependencies,
      ),
    ).resolves.toEqual([
      {
        mediaId: "video",
        size: 640,
        retryAfterMs: 5_000,
        status: "pending",
        variant: "preview",
      },
    ]);
    expect(resolvePreview).toHaveBeenCalledWith(video, 640);
  });

  it("isolates missing items without calling Shutter", async () => {
    await expect(
      resolveMediaDeliveryUrlsForVariants(
        [
          { mediaId: "missing", variant: "thumbnail" },
          { mediaId: "video", variant: "thumbnail" },
        ],
        dependencies,
      ),
    ).resolves.toEqual([
      { mediaId: "missing", status: "failed", variant: "thumbnail" },
      {
        mediaId: "video",
        status: "ready",
        url: "https://edge.shutter.test/master",
        variant: "thumbnail",
      },
    ]);
  });

  it("limits concurrent Shutter preview checks to six", async () => {
    const contexts = new Map<string, typeof video>();
    const items = Array.from({ length: 8 }, (_, index) => {
      const mediaId = `video-${index}`;
      contexts.set(mediaId, { ...video, mediaObjectId: mediaId, sha256: `${index}`.repeat(64) });
      return { mediaId, variant: "thumbnail" as const };
    });
    readContexts.mockResolvedValue(contexts);
    let active = 0;
    let maximum = 0;
    resolvePreview.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { status: "ready", url: "https://edge.shutter.test/master" };
    });

    await resolveMediaDeliveryUrlsForVariants(items, dependencies);
    expect(maximum).toBe(6);
  });
});
