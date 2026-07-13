import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readContexts: vi.fn(),
  resolveImage: vi.fn(),
  resolvePreview: vi.fn(),
}));

vi.mock("./repository", () => ({
  readMediaDeliveryRequest: vi.fn(),
  readMediaThumbnailContext: vi.fn(),
  readMediaThumbnailContextsByEntryIds: mocks.readContexts,
}));
vi.mock("./shutter-client", () => ({
  resolveShutterImageUrl: mocks.resolveImage,
  resolveShutterPreview: mocks.resolvePreview,
}));
vi.mock("./storage-client", () => ({ createPaneViewStorageClient: vi.fn() }));
vi.mock("@latch-works/media-storage", () => ({ createSignedGetUrl: vi.fn() }));

import { resolveMediaDeliveryUrlsForVariants } from "./resolve-delivery-url";

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
    mocks.readContexts.mockResolvedValue(
      new Map<string, typeof image | typeof video>([
        ["image", image],
        ["video", video],
      ]),
    );
    mocks.resolveImage.mockResolvedValue("https://edge.shutter.test/image");
    mocks.resolvePreview.mockResolvedValue({
      status: "ready",
      url: "https://edge.shutter.test/master",
    });
  });

  it("deduplicates and returns private Shutter image URLs", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "image", size: 321, variant: "thumbnail" },
      { mediaId: "image", size: 321, variant: "thumbnail" },
    ]);
    expect(results).toEqual([
      {
        mediaId: "image",
        size: 321,
        status: "ready",
        url: "https://edge.shutter.test/image",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.resolveImage).toHaveBeenCalledWith(image, 321);
    expect(mocks.resolvePreview).not.toHaveBeenCalled();
  });

  it("returns pending until video renditions are ready", async () => {
    mocks.resolvePreview.mockResolvedValueOnce({ status: "pending", retryAfterMs: 5_000 });
    await expect(
      resolveMediaDeliveryUrlsForVariants([{ mediaId: "video", size: 640, variant: "preview" }]),
    ).resolves.toEqual([
      {
        mediaId: "video",
        size: 640,
        retryAfterMs: 5_000,
        status: "pending",
        variant: "preview",
      },
    ]);
    expect(mocks.resolvePreview).toHaveBeenCalledWith(video, 640);
  });

  it("isolates missing items without calling Shutter", async () => {
    await expect(
      resolveMediaDeliveryUrlsForVariants([
        { mediaId: "missing", variant: "thumbnail" },
        { mediaId: "video", variant: "thumbnail" },
      ]),
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
    mocks.readContexts.mockResolvedValue(contexts);
    let active = 0;
    let maximum = 0;
    mocks.resolvePreview.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { status: "ready", url: "https://edge.shutter.test/master" };
    });

    await resolveMediaDeliveryUrlsForVariants(items);
    expect(maximum).toBe(6);
  });
});
