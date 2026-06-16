import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureThumbnailDerivativeForContext: vi.fn(),
  mintImageOriginalDeliveryToken: vi.fn(),
  readMediaDeliveryRequest: vi.fn(),
  readMediaThumbnailContextsByEntryIds: vi.fn(),
  resolveImageDeliveryMode: vi.fn(),
  buildDerivativeDeliveryUrl: vi.fn(),
  createSignedGetUrl: vi.fn(),
}));

vi.mock("../../env/image-delivery", () => ({
  resolveImageDeliveryMode: mocks.resolveImageDeliveryMode,
}));

vi.mock("./derivative-delivery-url", () => ({
  buildDerivativeDeliveryUrl: mocks.buildDerivativeDeliveryUrl,
}));

vi.mock("./delivery", () => ({
  planSignedOriginalDelivery: vi.fn(() => ({
    expiresInSeconds: 3600,
    objectKey: "objects/original",
  })),
}));

vi.mock("./image-delivery", () => ({
  mintImageOriginalDeliveryToken: mocks.mintImageOriginalDeliveryToken,
}));

vi.mock("./repository", () => ({
  readMediaDeliveryRequest: mocks.readMediaDeliveryRequest,
  readMediaThumbnailContext: vi.fn(),
  readMediaThumbnailContextsByEntryIds: mocks.readMediaThumbnailContextsByEntryIds,
}));

vi.mock("./derivative-service", () => ({
  ensurePreviewDerivative: vi.fn(),
  ensureThumbnailDerivative: vi.fn(),
  ensureThumbnailDerivativeForContext: mocks.ensureThumbnailDerivativeForContext,
  regenerateThumbnailDerivative: vi.fn(),
}));

vi.mock("@latch-works/media-storage", () => ({
  createSignedGetUrl: mocks.createSignedGetUrl,
}));

vi.mock("./storage-client", () => ({
  createPaneViewStorageClient: vi.fn(),
}));

import { resolveMediaDeliveryUrlsForVariants } from "./resolve-delivery-url";

const imageContext = {
  extension: "jpg",
  mediaObjectId: "obj-1",
  mediaType: "image" as const,
  originalObjectKey: "objects/abc",
  sha256: "a".repeat(64),
};

const videoContext = {
  extension: "mp4",
  mediaObjectId: "obj-2",
  mediaType: "video" as const,
  originalObjectKey: "objects/def",
  sha256: "b".repeat(64),
};

describe("resolveMediaDeliveryUrlsForVariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveImageDeliveryMode.mockReturnValue("bunny");
    mocks.readMediaThumbnailContextsByEntryIds.mockResolvedValue(
      new Map<string, typeof imageContext | typeof videoContext>([
        ["media-1", imageContext],
        ["media-2", videoContext],
      ]),
    );
    mocks.mintImageOriginalDeliveryToken.mockReturnValue("bunny-token");
    mocks.ensureThumbnailDerivativeForContext.mockResolvedValue({ status: "pending" });
  });

  it("dedupes duplicate batch entries", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-1", variant: "thumbnail", size: 320 },
      { mediaId: "media-1", variant: "thumbnail", size: 320 },
    ]);

    expect(results).toHaveLength(1);
    expect(mocks.readMediaThumbnailContextsByEntryIds).toHaveBeenCalledWith({
      mediaIds: ["media-1"],
    });
  });

  it("returns Bunny image delivery tokens without derivative ensure", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-1", variant: "thumbnail", size: 320 },
    ]);

    expect(results).toEqual([
      {
        deliveryToken: "bunny-token",
        mediaId: "media-1",
        size: 320,
        status: "ready",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.ensureThumbnailDerivativeForContext).not.toHaveBeenCalled();
  });

  it("returns failed for missing media without failing the batch", async () => {
    mocks.readMediaThumbnailContextsByEntryIds.mockResolvedValue(
      new Map([["media-1", imageContext]]),
    );

    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "missing", variant: "thumbnail", size: 320 },
      { mediaId: "media-1", variant: "thumbnail", size: 320 },
    ]);

    expect(results).toEqual([
      {
        mediaId: "missing",
        size: 320,
        status: "failed",
        variant: "thumbnail",
      },
      {
        deliveryToken: "bunny-token",
        mediaId: "media-1",
        size: 320,
        status: "ready",
        variant: "thumbnail",
      },
    ]);
  });

  it("maps pending video thumbnails to batch pending results", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-2", variant: "thumbnail", size: 320 },
    ]);

    expect(results).toEqual([
      {
        mediaId: "media-2",
        retryAfterMs: 15_000,
        size: 320,
        status: "pending",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.ensureThumbnailDerivativeForContext).toHaveBeenCalledWith({
      context: videoContext,
      requestedSize: 320,
    });
  });
});
