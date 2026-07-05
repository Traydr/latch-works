import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStoredObject: vi.fn(),
  verifyCdnDeliveryToken: vi.fn(),
}));

vi.mock("../../env/server", () => ({
  env: {
    MEDIA_DELIVERY_SECRET: "test-delivery-secret-32-characters",
    MEDIA_DELIVERY_TTL_SECONDS: 86_400,
  },
}));

vi.mock("@latch-works/media-storage", () => ({
  getStoredObject: mocks.getStoredObject,
}));

vi.mock("./storage-client", () => ({
  createPaneViewStorageClient: vi.fn(() => ({})),
}));

vi.mock("./cdn-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdn-delivery")>();
  return {
    ...actual,
    verifyCdnDeliveryToken: mocks.verifyCdnDeliveryToken,
  };
});

import { env } from "../../env/server";
import { serveCdnDeliveryRequest } from "./cdn-response";

describe("serveCdnDeliveryRequest", () => {
  beforeEach(() => {
    mocks.getStoredObject.mockReset();
    mocks.verifyCdnDeliveryToken.mockReset();
  });

  it("returns 403 for invalid tokens without reading storage", async () => {
    mocks.verifyCdnDeliveryToken.mockReturnValue(null);

    const response = await serveCdnDeliveryRequest({
      request: new Request("https://example.test/cdn/v1/bad"),
      token: "bad",
    });

    expect(response.status).toBe(403);
    expect(mocks.getStoredObject).not.toHaveBeenCalled();
  });

  it("sets bounded public cache-control for valid tokens", async () => {
    mocks.verifyCdnDeliveryToken.mockReturnValue({
      exp: Math.floor(Date.now() / 1000) + 3600,
      objectKey: "thumbnails/abc/320.webp",
      purpose: "thumbnail",
    });
    mocks.getStoredObject.mockResolvedValue({
      body: Readable.from([Buffer.from("webp")]),
      contentLength: 4,
      contentType: "image/webp",
      etag: '"etag"',
      statusCode: 200,
    });

    const response = await serveCdnDeliveryRequest({
      request: new Request("https://example.test/cdn/v1/good"),
      token: "good",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const cacheControl = response.headers.get("cache-control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).not.toContain("immutable");

    const maxAgeMatch = cacheControl?.match(/max-age=(\d+)/);
    expect(maxAgeMatch).not.toBeNull();
    expect(Number(maxAgeMatch?.[1])).toBeLessThanOrEqual(env.MEDIA_DELIVERY_TTL_SECONDS);
  });

  it("sets nosniff on HEAD responses", async () => {
    mocks.verifyCdnDeliveryToken.mockReturnValue({
      exp: Math.floor(Date.now() / 1000) + 3600,
      objectKey: "originals/sha256/ab/cd/photo.jpg",
      purpose: "original",
    });
    mocks.getStoredObject.mockResolvedValue({
      body: Readable.from([Buffer.from("jpeg")]),
      contentLength: 4,
      contentType: "image/jpeg",
      etag: '"etag"',
      statusCode: 200,
    });

    const response = await serveCdnDeliveryRequest({
      request: new Request("https://example.test/cdn/v1/good", { method: "HEAD" }),
      token: "good",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
