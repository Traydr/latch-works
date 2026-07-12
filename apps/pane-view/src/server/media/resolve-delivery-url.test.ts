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
    mocks.resolveImage.mockResolvedValue("https://shutter.test/image");
    mocks.resolvePreview.mockResolvedValue({ status: "pending", retryAfterMs: 7_000 });
  });

  it("deduplicates and resolves images only through Shutter", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "image", size: 321, variant: "thumbnail" },
      { mediaId: "image", size: 321, variant: "thumbnail" },
    ]);
    expect(results).toEqual([
      {
        mediaId: "image",
        size: 321,
        status: "ready",
        url: "https://shutter.test/image",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.resolveImage).toHaveBeenCalledWith(image, 321);
  });

  it("preserves Shutter preview retry timing", async () => {
    await expect(
      resolveMediaDeliveryUrlsForVariants([{ mediaId: "video", size: 640, variant: "preview" }]),
    ).resolves.toEqual([
      {
        mediaId: "video",
        retryAfterMs: 7_000,
        size: 640,
        status: "pending",
        variant: "preview",
      },
    ]);
  });

  it("isolates missing and terminally failed items", async () => {
    mocks.resolvePreview.mockResolvedValue({ status: "failed" });
    await expect(
      resolveMediaDeliveryUrlsForVariants([
        { mediaId: "missing", variant: "thumbnail" },
        { mediaId: "video", variant: "thumbnail" },
      ]),
    ).resolves.toEqual([
      { mediaId: "missing", status: "failed", variant: "thumbnail" },
      { mediaId: "video", status: "failed", variant: "thumbnail" },
    ]);
  });
});
