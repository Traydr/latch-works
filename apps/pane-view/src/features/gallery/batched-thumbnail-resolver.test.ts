import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetGalleryThumbnailResolverForTests,
  getNextPendingThumbnailRetryMs,
  hasEligibleGalleryThumbnailRequests,
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

  it("drains 49 ready requests in batches no larger than 48", async () => {
    const requests = Array.from({ length: 49 }, (_, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    mocks.resolveMediaDeliveryUrls.mockImplementation(({ data }) =>
      Promise.resolve({
        results: data.items.map((item: { mediaId: string; size: number }) => ({
          ...item,
          status: "ready",
          url: `https://edge.shutter.test/${item.mediaId}`,
          variant: "thumbnail",
        })),
      }),
    );

    await resolveGalleryThumbnailsBatch(requests);
    expect(hasEligibleGalleryThumbnailRequests(requests)).toBe(true);
    await resolveGalleryThumbnailsBatch(requests);

    expect(mocks.resolveMediaDeliveryUrls).toHaveBeenCalledTimes(2);
    expect(mocks.resolveMediaDeliveryUrls.mock.calls.map(([call]) => call.data.items)).toHaveLength(
      2,
    );
    expect(
      mocks.resolveMediaDeliveryUrls.mock.calls.map(([call]) => call.data.items.length),
    ).toEqual([48, 1]);
    expect(hasEligibleGalleryThumbnailRequests(requests)).toBe(false);
  });

  it("keeps every batch bounded while draining 97 ready requests", async () => {
    const requests = Array.from({ length: 97 }, (_, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    mocks.resolveMediaDeliveryUrls.mockImplementation(({ data }) =>
      Promise.resolve({
        results: data.items.map((item: { mediaId: string; size: number }) => ({
          ...item,
          status: "ready",
          url: `https://edge.shutter.test/${item.mediaId}`,
          variant: "thumbnail",
        })),
      }),
    );

    while (hasEligibleGalleryThumbnailRequests(requests)) {
      await resolveGalleryThumbnailsBatch(requests);
    }

    expect(
      mocks.resolveMediaDeliveryUrls.mock.calls.map(([call]) => call.data.items.length),
    ).toEqual([48, 48, 1]);
  });

  it("keeps immediately eligible work distinct from delayed pending retries", async () => {
    const requests = Array.from({ length: 49 }, (_, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    mocks.resolveMediaDeliveryUrls
      .mockResolvedValueOnce({
        results: [
          {
            mediaId: requests[0]?.mediaId,
            retryAfterMs: 15_000,
            size: 720,
            status: "pending",
            variant: "thumbnail",
          },
          ...requests.slice(1, 48).map((request) => ({
            mediaId: request.mediaId,
            size: 720,
            status: "failed",
            variant: "thumbnail",
          })),
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            mediaId: requests[48]?.mediaId,
            size: 720,
            status: "failed",
            variant: "thumbnail",
          },
        ],
      });

    await resolveGalleryThumbnailsBatch(requests);

    expect(hasEligibleGalleryThumbnailRequests(requests)).toBe(true);
    expect(getNextPendingThumbnailRetryMs(requests)).toBeGreaterThan(0);

    await resolveGalleryThumbnailsBatch(requests);

    expect(
      mocks.resolveMediaDeliveryUrls.mock.calls.map(([call]) => call.data.items.length),
    ).toEqual([48, 1]);
    expect(hasEligibleGalleryThumbnailRequests(requests)).toBe(false);
    expect(getNextPendingThumbnailRetryMs(requests)).toBeGreaterThan(0);
  });
});
