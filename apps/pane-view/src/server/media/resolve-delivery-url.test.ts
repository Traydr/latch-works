import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureThumbnailDerivativeForContext: vi.fn(),
  mintImageOriginalDeliveryToken: vi.fn(),
  readMediaDeliveryRequest: vi.fn(),
  readMediaThumbnailContextsByEntryIds: vi.fn(),
  resolveImageDeliveryMode: vi.fn(),
  buildDerivativeDeliveryUrl: vi.fn(),
  createSignedGetUrl: vi.fn(),
  resolveShutterImageUrl: vi.fn(),
  resolveShutterPreview: vi.fn(),
  usesShutterPreview: vi.fn(),
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

vi.mock("./shutter-client", () => ({
  resolveShutterImageUrl: mocks.resolveShutterImageUrl,
  resolveShutterPreview: mocks.resolveShutterPreview,
  usesShutterPreview: mocks.usesShutterPreview,
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
    mocks.resolveShutterImageUrl.mockResolvedValue("https://shutter.test/private-image");
    mocks.resolveShutterPreview.mockResolvedValue({ status: "pending", retryAfterMs: 5_000 });
    mocks.usesShutterPreview.mockReturnValue(false);
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

  it("returns Bunny fallback tokens when image derivatives are pending", async () => {
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-1", variant: "thumbnail", size: 720 },
    ]);

    expect(results).toEqual([
      {
        deliveryToken: "bunny-token",
        mediaId: "media-1",
        size: 720,
        status: "ready",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.ensureThumbnailDerivativeForContext).toHaveBeenCalledWith({
      context: imageContext,
      requestedSize: 720,
    });
  });

  it("returns CDN URLs when image derivatives are ready", async () => {
    mocks.ensureThumbnailDerivativeForContext.mockResolvedValue({
      height: 405,
      objectKey: "thumbnails/sha256/ab/cd/hash-720.webp",
      purpose: "thumbnail",
      status: "ready",
      width: 720,
    });
    mocks.buildDerivativeDeliveryUrl.mockResolvedValue("https://cdn.example/thumb.webp");

    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-1", variant: "thumbnail", size: 720 },
    ]);

    expect(results).toEqual([
      {
        mediaId: "media-1",
        size: 720,
        status: "ready",
        url: "https://cdn.example/thumb.webp",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.mintImageOriginalDeliveryToken).not.toHaveBeenCalled();
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

  it("routes pdf thumbnails through the queued derivative path, not Bunny", async () => {
    const pdfContext = {
      extension: "pdf",
      mediaObjectId: "obj-3",
      mediaType: "pdf" as const,
      originalObjectKey: "objects/ghi",
      sha256: "c".repeat(64),
    };
    mocks.readMediaThumbnailContextsByEntryIds.mockResolvedValue(
      new Map([["media-3", pdfContext]]),
    );
    mocks.ensureThumbnailDerivativeForContext.mockResolvedValue({
      height: 1122,
      objectKey: "previews/pdf/sha/320.webp",
      purpose: "preview",
      status: "ready",
      width: 864,
    });
    mocks.buildDerivativeDeliveryUrl.mockResolvedValue("https://cdn.example/preview.webp");

    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-3", variant: "thumbnail", size: 320 },
    ]);

    expect(mocks.mintImageOriginalDeliveryToken).not.toHaveBeenCalled();
    expect(mocks.ensureThumbnailDerivativeForContext).toHaveBeenCalledWith({
      context: pdfContext,
      requestedSize: 320,
    });
    expect(results).toEqual([
      {
        mediaId: "media-3",
        size: 320,
        status: "ready",
        url: "https://cdn.example/preview.webp",
        variant: "thumbnail",
      },
    ]);
  });

  it("routes private still images directly through Shutter", async () => {
    mocks.resolveImageDeliveryMode.mockReturnValue("shutter");
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-1", variant: "thumbnail", size: 321 },
    ]);
    expect(results).toEqual([
      {
        mediaId: "media-1",
        size: 321,
        status: "ready",
        url: "https://shutter.test/private-image",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.resolveShutterImageUrl).toHaveBeenCalledWith(imageContext, 321);
    expect(mocks.ensureThumbnailDerivativeForContext).not.toHaveBeenCalled();
  });

  it("maps Shutter video jobs to the shared polling result", async () => {
    mocks.usesShutterPreview.mockImplementation((mediaType) => mediaType === "video");
    const results = await resolveMediaDeliveryUrlsForVariants([
      { mediaId: "media-2", variant: "thumbnail", size: 320 },
    ]);
    expect(results).toEqual([
      {
        mediaId: "media-2",
        retryAfterMs: 5_000,
        size: 320,
        status: "pending",
        variant: "thumbnail",
      },
    ]);
    expect(mocks.resolveShutterPreview).toHaveBeenCalledWith(videoContext, 320);
    expect(mocks.ensureThumbnailDerivativeForContext).not.toHaveBeenCalled();
  });
});
