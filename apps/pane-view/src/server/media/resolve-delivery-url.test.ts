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
  });

  it("deduplicates and returns same-origin thumbnail API URLs", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "image", size: 321, variant: "thumbnail" },
      { mediaId: "image", size: 321, variant: "thumbnail" },
    ]);
    expect(results).toEqual([
      {
        mediaId: "image",
        size: 321,
        status: "ready",
        url: "/api/media/image/thumbnail?size=320",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.resolveImage).not.toHaveBeenCalled();
    expect(mocks.resolvePreview).not.toHaveBeenCalled();
  });

  it("returns preview API URLs for video renditions", async () => {
    await expect(
      resolveMediaDeliveryUrlsForVariants([{ mediaId: "video", size: 640, variant: "preview" }]),
    ).resolves.toEqual([
      {
        mediaId: "video",
        size: 640,
        status: "ready",
        url: "/api/media/video/preview",
        variant: "preview",
      },
    ]);
    expect(mocks.resolvePreview).not.toHaveBeenCalled();
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
        url: "/api/media/video/thumbnail?size=320",
        variant: "thumbnail",
      },
    ]);
  });
});
