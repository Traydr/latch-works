import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueShutterCapability, shutterCapabilityClaimTimes } from "./shutter-capability";
import {
  normalizeShutterWidth,
  purgeShutterSource,
  resolveShutterImageUrl,
  resolveShutterPreview,
  type ShutterClientDependencies,
  type ShutterEnvironment,
} from "./shutter-client";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = Buffer.from(KEY).toString("base64url");

/** t3-env's values are readonly; a case here rewrites the registry it tests. */
type MutableShutterEnvironment = {
  -readonly [Key in keyof ShutterEnvironment]: ShutterEnvironment[Key];
};

/** The Shutter configuration under test; each case mutates it directly. */
const environment: MutableShutterEnvironment = {
  SHUTTER_CAPABILITY_KEYS: "",
  SHUTTER_CAPABILITY_KID: "active-key",
  SHUTTER_CONTROL_URL: "https://control.shutter.test",
  SHUTTER_EDGE_URL: "https://edge.shutter.test",
  SHUTTER_SPACE_API_TOKEN: "s".repeat(32),
  SHUTTER_SPACE_ID: "pane-view",
};

const createSourceLocator = vi.fn(async () => "https://storage.test/original?signature=test");
const dependencies: ShutterClientDependencies = { createSourceLocator, environment };

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
    environment.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "pane-view": { "active-key": encodedKey },
    });
    createSourceLocator.mockResolvedValue(
      "https://t3.storageapi.dev/original?X-Amz-Signature=test",
    );
  });

  it("accepts a flat capability-key registry", async () => {
    environment.SHUTTER_CAPABILITY_KEYS = JSON.stringify({ "active-key": encodedKey });
    await expect(resolveShutterImageUrl(image, 320, dependencies)).resolves.toMatch(
      /^https:\/\/edge\.shutter\.test/u,
    );
    environment.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "pane-view": { "active-key": encodedKey },
    });
  });

  it("rejects invalid source ids before issuing capabilities", async () => {
    await expect(
      resolveShutterImageUrl({ ...image, sha256: "not-a-hash" }, 320, dependencies),
    ).rejects.toThrow("SHA-256");
  });

  it("builds a normalized private image-source URL", async () => {
    const url = new URL(await resolveShutterImageUrl(image, 321, dependencies));
    expect(url.origin).toBe("https://edge.shutter.test");
    expect(url.pathname).toMatch(/^\/v1\/private\/pane-view\/source\/v1\.active-key\./u);
    expect(url.search).toBe("?w=640&q=75");
    expect(createSourceLocator).toHaveBeenCalledWith({
      expiresInSeconds: 86_700,
      key: image.originalObjectKey,
    });
  });

  it("issues capabilities for the documented 24-hour lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const times = shutterCapabilityClaimTimes();
    expect(times.exp - times.iat).toBe(86_400);
    vi.useRealTimers();
  });

  it("matches Shutter's versioned AES-GCM image capability fixture", async () => {
    environment.SHUTTER_SPACE_ID = "fixture-space";
    environment.SHUTTER_CAPABILITY_KID = "fixture-key-2026-07";
    environment.SHUTTER_CAPABILITY_KEYS = JSON.stringify({
      "fixture-space": { "fixture-key-2026-07": encodedKey },
    });
    await expect(
      issueShutterCapability(
        {
          space_id: "fixture-space",
          source_id: "image/source 01",
          purpose: "image_source",
          iat: 1_800_000_000,
          exp: 1_800_003_600,
          locator: "https://sources.example.test/objects/image-01?signature=test",
        },
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        environment,
      ),
    ).resolves.toBe(
      "v1.fixture-key-2026-07.AAECAwQFBgcICQoL.PCCla6SGp0TkJbWxk48RFfej9VHdCC8dWwLHqT8ab8dzc8ujxqUwolbNEozv4gdLgSwS7j_2k-sduwhpbZGFgYNZ5EDxuEsAezH1HYD6fItdqOVAHwInSsfMpvxIwIm9-8hpyoYksGq8Jg-KeEURT4lRUpvP50n1Lp4jovDEVCzTJnS2x-3kfHuOPdNevz_sU4yCWEV99mT4OpsD1b2LhPb06mbGlqEfwAbwyu6_9dL6oKtW_tkWgRG6s7NTuF3Hbtg2jPjUy839pXuzVJA",
    );
    environment.SHUTTER_SPACE_ID = "pane-view";
    environment.SHUTTER_CAPABILITY_KID = "active-key";
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
    await expect(resolveShutterPreview(video, 320, dependencies)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 5_000,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        `/v1/spaces/pane-view/sources/${video.sha256}/previews/video`,
        environment.SHUTTER_CONTROL_URL,
      ),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          authorization: `Bearer ${environment.SHUTTER_SPACE_API_TOKEN}`,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("returns a private master URL when the job is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          master: {
            format: "webp",
            height: 1080,
            kind: "video",
            sourceId: video.sha256,
            width: 1920,
          },
          status: "ready",
        }),
      ),
    );
    const result = await resolveShutterPreview(video, 900, dependencies);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready result");
    const url = new URL(result.url);
    expect(url.pathname).toMatch(/^\/v1\/private\/pane-view\/master\/v1\.active-key\./u);
    expect(url.search).toBe("?w=960&q=75");
    vi.unstubAllGlobals();
  });

  it("preserves persisted Shutter failure classification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          failure: { action: "replace_source", code: "unsupported_media" },
          status: "failed",
        }),
      ),
    );
    await expect(resolveShutterPreview(video, 320, dependencies)).resolves.toEqual({
      action: "replace_source",
      code: "unsupported_media",
      status: "failed",
    });
    vi.unstubAllGlobals();
  });

  it("distinguishes retryable Control failures from terminal responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "retry-after": "9" } }))
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    await expect(resolveShutterPreview(video, 320, dependencies)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 9_000,
    });
    await expect(resolveShutterPreview(video, 320, dependencies)).resolves.toEqual({
      action: undefined,
      code: undefined,
      status: "failed",
    });
    vi.unstubAllGlobals();
  });

  it("purges sources idempotently and rejects non-204 responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(purgeShutterSource("source/id", dependencies)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/v1/spaces/pane-view/sources/source%2Fid/purge", environment.SHUTTER_CONTROL_URL),
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(purgeShutterSource("source/id", dependencies)).rejects.toThrow("503");
    vi.unstubAllGlobals();
  });
});
