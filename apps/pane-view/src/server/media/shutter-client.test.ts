import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const encodedKey = Buffer.from(KEY).toString("base64url");
const mocks = vi.hoisted(() => ({
  createSignedGetUrl: vi.fn(),
  env: {
    PDF_PREVIEW_PROVIDER: "shutter",
    SHUTTER_CAPABILITY_KEYS: "",
    SHUTTER_CAPABILITY_KID: "active-key",
    SHUTTER_CONTROL_URL: "https://control.shutter.test",
    SHUTTER_EDGE_URL: "https://edge.shutter.test",
    SHUTTER_SPACE_API_TOKEN: "s".repeat(32),
    SHUTTER_SPACE_ID: "pane-view",
    VIDEO_PREVIEW_PROVIDER: "shutter",
  },
}));

vi.mock("../../env/server", () => ({ env: mocks.env }));
vi.mock("@latch-works/media-storage", () => ({
  createSignedGetUrl: mocks.createSignedGetUrl,
}));
vi.mock("./storage-client", () => ({ createPaneViewStorageClient: vi.fn(() => ({})) }));

import { resolveShutterImageUrl, resolveShutterPreview } from "./shutter-client";

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

  it("builds a normalized private image-source URL", async () => {
    const url = new URL(await resolveShutterImageUrl(image, 321));
    expect(url.origin).toBe("https://edge.shutter.test");
    expect(url.pathname).toMatch(/^\/v1\/private\/pane-view\/source\/v1\.active-key\./u);
    expect(url.search).toBe("?w=640&q=75");
    expect(mocks.createSignedGetUrl).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInSeconds: 86_400, key: image.originalObjectKey }),
    );
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
});
