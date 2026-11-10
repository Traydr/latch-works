import { verifyAccessToken } from "@shutter/protocol";
import { describe, expect, it } from "vitest";
import {
  type EnabledShutter,
  purgeShutterSource,
  resolveShutterImageUrl,
  resolveShutterOriginalUrl,
  resolveShutterPreview,
  type ShutterClientDependencies,
  type ShutterSource,
} from "./shutter-client";
import { parseShutterConfig } from "./shutter-config";

/**
 * The v2 switch: with a resolver ID every URL names the object by its key and
 * carries a locator-free access token, nothing is presigned here, and a purge
 * covers every Source ID the object may have been cached under.
 */
const KEY = "1".repeat(64);

const SHA256 = "ab".repeat(32);

const KEYS = new Map([["key-id", Uint8Array.from(Buffer.from(KEY, "hex"))]]);

const OBJECT_KEY = `originals/sha256/ab/ab/${SHA256}.jpg`;

const shutterConfig = parseShutterConfig({
  SHUTTER_CAPABILITY_KEYS: `{"pane-view":{"key-id":"${KEY}"}}`,
  SHUTTER_CAPABILITY_KID: "key-id",
  SHUTTER_CONTROL_URL: "https://control.shutter.test",
  SHUTTER_EDGE_URL: "https://edge.shutter.test",
  SHUTTER_RESOLVER_ID: "originals",
  SHUTTER_SPACE_API_TOKEN: "test-shutter-space-api-token-at-least-32",
  SHUTTER_SPACE_ID: "pane-view",
});

if (shutterConfig.mode !== "on") throw new Error("the test configuration turns Shutter on");

const shutter: EnabledShutter = shutterConfig;

const source: ShutterSource = { objectKey: OBJECT_KEY, sha256: SHA256 };

/**
 * Control answers `responses` in turn. Only the v1 path presigns a source locator; with `presign`
 * off, asking for one fails the call.
 */
function dependencies(
  responses: Response[] = [],
  { presign = false } = {},
): ShutterClientDependencies & { requests: Request[] } {
  const requests: Request[] = [];

  return {
    createSourceLocator: async () => {
      if (!presign) throw new Error("the v2 path presigns nothing");

      return "https://bucket.example.test/originals?X-Amz-Signature=v1";
    },
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      const next = responses.shift();

      if (next === undefined) throw new Error("fetch stub exhausted");

      return next;
    },
    requests,
  };
}

describe("shutter v2 resolver sources", () => {
  it("serves an image as a v2 Delivery URL with an image_source token", async () => {
    const deps = dependencies();
    const url = new URL(await resolveShutterImageUrl(source, 300, shutter, deps));

    expect(url.origin).toBe("https://edge.shutter.test");
    expect(url.pathname).toBe(`/v2/pane-view/originals/ab/ab/${SHA256}.jpg`);
    expect(url.searchParams.get("w")).toBe("320");
    expect(url.searchParams.get("q")).toBe("75");

    const claims = await verifyAccessToken(url.searchParams.get("token") ?? "", {
      spaceId: "pane-view",
      expectedPurpose: "image_source",
      expectedSourceId: `originals/ab/ab/${SHA256}.jpg`,
      keys: KEYS,
      now: Math.floor(Date.now() / 1000),
    });

    expect(claims.purpose).toBe("image_source");
  });

  it("serves an original as a bare v2 Delivery URL with a source_delivery token", async () => {
    const deps = dependencies();
    const url = new URL(await resolveShutterOriginalUrl(source, shutter, deps));

    expect(url.pathname).toBe(`/v2/pane-view/originals/ab/ab/${SHA256}.jpg`);
    expect([...url.searchParams.keys()]).toEqual(["token"]);

    const claims = await verifyAccessToken(url.searchParams.get("token") ?? "", {
      spaceId: "pane-view",
      expectedPurpose: "source_delivery",
      expectedSourceId: `originals/ab/ab/${SHA256}.jpg`,
      keys: KEYS,
      now: Math.floor(Date.now() / 1000),
    });

    expect(claims.purpose).toBe("source_delivery");
  });

  it("submits a v2 Preview Job and links the master with a master_preview token", async () => {
    const master = { sourceId: "x", kind: "video", width: 1920, height: 1080, format: "webp" };

    const deps = dependencies([
      new Response(JSON.stringify({ status: "ready", master }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);

    const preview = await resolveShutterPreview(source, "video", 960, shutter, deps);

    expect(deps.requests[0]?.method).toBe("PUT");
    expect(new URL(deps.requests[0]?.url ?? "").pathname).toBe(
      `/v2/spaces/pane-view/sources/originals%2Fab%2Fab%2F${SHA256}.jpg/previews/video`,
    );

    if (preview.status !== "ready") throw new Error("preview should be ready");
    const url = new URL(preview.url);
    expect(url.searchParams.get("preview")).toBe("video");
    await expect(
      verifyAccessToken(url.searchParams.get("token") ?? "", {
        spaceId: "pane-view",
        expectedPurpose: "master_preview",
        expectedKind: "video",
        expectedSourceId: `originals/ab/ab/${SHA256}.jpg`,
        keys: KEYS,
        now: Math.floor(Date.now() / 1000),
      }),
    ).resolves.toMatchObject({ kind: "video" });
  });

  it("purges both Source IDs when the key is known and the SHA-256 alone otherwise", async () => {
    const deps = dependencies([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);

    await purgeShutterSource(source, shutter, deps);
    await purgeShutterSource({ objectKey: null, sha256: SHA256 }, shutter, deps);

    expect(deps.requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v2/spaces/pane-view/sources/originals%2Fab%2Fab%2F${SHA256}.jpg/purge`,
      `/v1/spaces/pane-view/sources/${SHA256}/purge`,
      `/v1/spaces/pane-view/sources/${SHA256}/purge`,
    ]);
  });

  it("takes the v1 path for a key outside the originals layout and when the resolver is unset", async () => {
    const legacy = await resolveShutterImageUrl(
      { ...source, objectKey: "uploads/x.jpg" },
      300,
      shutter,
      dependencies([], { presign: true }),
    );

    expect(new URL(legacy).pathname.startsWith("/v1/private/pane-view/source/")).toBe(true);

    const withoutResolver = { ...shutter, resolverId: null };
    const deps = dependencies([new Response(null, { status: 204 })], { presign: true });
    const rolledBack = await resolveShutterImageUrl(source, 300, withoutResolver, deps);
    expect(new URL(rolledBack).pathname.startsWith("/v1/private/pane-view/source/")).toBe(true);
    await purgeShutterSource(source, withoutResolver, deps);
    expect(deps.requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/spaces/pane-view/sources/${SHA256}/purge`,
    ]);
  });
});
