import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = Buffer.from(KEY).toString("base64url");
const mocks = vi.hoisted(() => ({
  createSignedGetUrl: vi.fn(),
  env: {
    SHUTTER_CAPABILITY_KEYS: "",
    SHUTTER_CAPABILITY_KID: "active-key",
    SHUTTER_CONTROL_URL: "https://control.shutter.test",
    SHUTTER_EDGE_URL: "https://edge.shutter.test",
    SHUTTER_SPACE_API_TOKEN: "s".repeat(32),
    SHUTTER_SPACE_ID: "pane-view",
  },
}));

vi.mock("../../env/server", () => ({ env: mocks.env }));
vi.mock("@latch-works/media-storage", () => ({
  createSignedGetUrl: mocks.createSignedGetUrl,
}));
vi.mock("./storage-client", () => ({ createPaneViewStorageClient: vi.fn(() => ({})) }));

import {
  normalizeShutterWidth,
  purgeShutterSource,
  resolveShutterImageUrl,
  resolveShutterPreview,
  shutterClientTestHooks,
} from "./shutter-client";

const image = {
  extension: "jpg",
  mediaObjectId: "object-1",
  mediaType: "image" as const,
  originalObjectKey: "originals/image.jpg",
  sha256: "a".repeat(64),
};
const video = { ...image, mediaType: "video" as const, sha256: "b".repeat(64) };

describe("Shutter Pane View client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "pane-view": { "active-key": encodedKey },
    });
    mocks.createSignedGetUrl.mockResolvedValue(
      "https://t3.storageapi.dev/original?X-Amz-Signature=test",
    );
  });

  it("accepts a flat capability-key registry", async () => {
    mocks.env.SHUTTER_CAPABILITY_KEYS = JSON.stringify({ "active-key": encodedKey });
    await expect(resolveShutterImageUrl(image, 320)).resolves.toMatch(/^https:\/\/edge\.shutter\.test/u);
    mocks.env.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "pane-view": { "active-key": encodedKey },
    });
  });

  it("rejects invalid source ids before issuing capabilities", async () => {
    await expect(resolveShutterImageUrl({ ...image, sha256: "not-a-hash" }, 320)).rejects.toThrow(
      "SHA-256",
    );
  });

  it("builds a normalized private image-source URL", async () => {
    const url = new URL(await resolveShutterImageUrl(image, 321));
    expect(url.origin).toBe("https://edge.shutter.test");
    expect(url.pathname).toMatch(/^\/v1\/private\/pane-view\/source\/v1\.active-key\./u);
    expect(url.search).toBe("?w=640&q=75");
    expect(mocks.createSignedGetUrl).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 86_400, key: image.originalObjectKey }),
    );
  });

  it("matches Shutter's versioned AES-GCM image capability fixture", async () => {
    mocks.env.SHUTTER_SPACE_ID = "fixture-space";
    mocks.env.SHUTTER_CAPABILITY_KID = "fixture-key-2026-07";
    mocks.env.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "fixture-space": { "fixture-key-2026-07": encodedKey },
    });
    await expect(
      shutterClientTestHooks.issueCapability(
        {
          space_id: "fixture-space",
          source_id: "image/source 01",
          purpose: "image_source",
          iat: 1_800_000_000,
          exp: 1_800_003_600,
          locator: "https://sources.example.test/objects/image-01?signature=test",
        },
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      ),
    ).resolves.toBe(
      "v1.fixture-key-2026-07.AAECAwQFBgcICQoL.PCCla6SGp0TkJbWxk48RFfej9VHdCC8dWwLHqT8ab8dzc8ujxqUwolbNEozv4gdLgSwS7j_2k-sduwhpbZGFgYNZ5EDxuEsAezH1HYD6fItdqOVAHwInSsfMpvxIwIm9-8hpyoYksGq8Jg-KeEURT4lRUpvP50n1Lp4jovDEVCzTJnS2x-3kfHuOPdNevz_sU4yCWEV99mT4OpsD1b2LhPb06mbGlqEfwAbwyu6_9dL6oKtW_tkWgRG6s7NTuF3Hbtg2jPjUy839pXuzVJA",
    );
    mocks.env.SHUTTER_SPACE_ID = "pane-view";
    mocks.env.SHUTTER_CAPABILITY_KID = "active-key";
  });

  it("normalizes placeholder and responsive widths", () => {
    expect(normalizeShutterWidth(24)).toBe(24);
    expect(normalizeShutterWidth(321)).toBe(640);
    expect(normalizeShutterWidth(9_999)).toBe(3_840);
  });

  it("submits an idempotent preview job and maps active polling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ status: "pending" }, { status: 202, headers: { "retry-after": "5" } }),
      ),
    );
    await expect(resolveShutterPreview(video, 320)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 5_000,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        `/v1/spaces/pane-view/sources/${video.sha256}/previews/video`,
        mocks.env.SHUTTER_CONTROL_URL,
      ),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          authorization: `Bearer ${mocks.env.SHUTTER_SPACE_API_TOKEN}`,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("returns a private master URL when the job is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "ready" })),
    );
    const result = await resolveShutterPreview(video, 900);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready result");
    const url = new URL(result.url);
    expect(url.pathname).toMatch(/^\/v1\/private\/pane-view\/master\/v1\.active-key\./u);
    expect(url.search).toBe("?w=960&q=75");
    vi.unstubAllGlobals();
  });

  it("distinguishes retryable Control failures from terminal responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "retry-after": "9" } }))
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    await expect(resolveShutterPreview(video, 320)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 9_000,
    });
    await expect(resolveShutterPreview(video, 320)).resolves.toEqual({ status: "failed" });
    vi.unstubAllGlobals();
  });

  it("purges sources idempotently and rejects non-204 responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(purgeShutterSource("source/id")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/v1/spaces/pane-view/sources/source%2Fid/purge", mocks.env.SHUTTER_CONTROL_URL),
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(purgeShutterSource("source/id")).rejects.toThrow("503");
    vi.unstubAllGlobals();
  });
});
