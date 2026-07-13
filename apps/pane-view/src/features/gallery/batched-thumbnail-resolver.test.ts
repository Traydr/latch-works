import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetGalleryThumbnailResolverForTests,
  getNextPendingThumbnailRetryMs,
  resolveGalleryThumbnailsBatch,
} from "./batched-thumbnail-resolver";

const mocks = vi.hoisted(() => ({
  resolveMediaDeliveryUrls: vi.fn(),
}));

vi.mock("@/features/media/media-delivery-service", () => ({
  resolveMediaDeliveryUrls: mocks.resolveMediaDeliveryUrls,
}));

describe("resolveGalleryThumbnailsBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetGalleryThumbnailResolverForTests();
  });

  it("dedupes visible-window requests and respects ready/pending cache state", async () => {
    mocks.resolveMediaDeliveryUrls.mockResolvedValueOnce({
      results: [
        {
          mediaId: "00000000-0000-4000-8000-000000000001",
          size: 720,
          status: "ready",
          url: "https://edge.shutter.test/ready",
          variant: "thumbnail",
        },
        {
          mediaId: "00000000-0000-4000-8000-000000000002",
          retryAfterMs: 15_000,
          size: 720,
          status: "pending",
          variant: "thumbnail",
        },
      ],
    });

    const first = await resolveGalleryThumbnailsBatch([
      { mediaId: "00000000-0000-4000-8000-000000000001" },
      { mediaId: "00000000-0000-4000-8000-000000000001" },
      { mediaId: "00000000-0000-4000-8000-000000000002" },
    ]);

    expect(mocks.resolveMediaDeliveryUrls).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMediaDeliveryUrls).toHaveBeenCalledWith({
      data: {
        items: [
          {
            mediaId: "00000000-0000-4000-8000-000000000001",
            size: 720,
            variant: "thumbnail",
          },
          {
            mediaId: "00000000-0000-4000-8000-000000000002",
            size: 720,
            variant: "thumbnail",
          },
        ],
      },
    });
    expect(first).toEqual({
      urls: {
        "00000000-0000-4000-8000-000000000001": "https://edge.shutter.test/ready",
      },
    });

    const second = await resolveGalleryThumbnailsBatch([
      { mediaId: "00000000-0000-4000-8000-000000000001" },
      { mediaId: "00000000-0000-4000-8000-000000000002" },
    ]);

    expect(mocks.resolveMediaDeliveryUrls).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("reports the earliest pending retry delay for visible requests", async () => {
    mocks.resolveMediaDeliveryUrls.mockResolvedValueOnce({
      results: [
        {
          mediaId: "00000000-0000-4000-8000-000000000001",
          retryAfterMs: 15_000,
          size: 720,
          status: "pending",
          variant: "thumbnail",
        },
        {
          mediaId: "00000000-0000-4000-8000-000000000002",
          retryAfterMs: 30_000,
          size: 720,
          status: "pending",
          variant: "thumbnail",
        },
      ],
    });

    await resolveGalleryThumbnailsBatch([
      { mediaId: "00000000-0000-4000-8000-000000000001" },
      { mediaId: "00000000-0000-4000-8000-000000000002" },
    ]);

    const retryDelayMs = getNextPendingThumbnailRetryMs([
      { mediaId: "00000000-0000-4000-8000-000000000001" },
      { mediaId: "00000000-0000-4000-8000-000000000002" },
    ]);

    expect(retryDelayMs).not.toBeNull();
    expect(retryDelayMs).toBeGreaterThan(0);
    expect(retryDelayMs).toBeLessThanOrEqual(30_000);
  });

  it("caches terminal batch failures without scheduling another poll", async () => {
    mocks.resolveMediaDeliveryUrls.mockResolvedValueOnce({
      results: [
        {
          mediaId: "00000000-0000-4000-8000-000000000003",
          size: 720,
          status: "failed",
          variant: "thumbnail",
        },
      ],
    });

    const first = await resolveGalleryThumbnailsBatch([
      { mediaId: "00000000-0000-4000-8000-000000000003" },
    ]);
    expect(first.urls).toEqual({});
    expect(
      getNextPendingThumbnailRetryMs([{ mediaId: "00000000-0000-4000-8000-000000000003" }]),
    ).toBeNull();

    await resolveGalleryThumbnailsBatch([{ mediaId: "00000000-0000-4000-8000-000000000003" }]);
    expect(mocks.resolveMediaDeliveryUrls).toHaveBeenCalledTimes(1);
  });
});
