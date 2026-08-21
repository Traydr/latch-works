import { describe, expect, it } from "vitest";
import type { MediaThumbnailContext } from "./repository";
import type { ShutterEnvironment } from "./shutter-client";
import {
  isShutterConfigured,
  resolveVariantImageUrl,
  resolveVariantPreview,
  type VariantProviderDependencies,
} from "./variant-provider";

const context: MediaThumbnailContext = {
  extension: "jpg",
  mediaObjectId: "media-object-1",
  mediaType: "image",
  originalObjectKey: "originals/sha256/ab/cd/abcd.jpg",
  sha256: "a".repeat(64),
};

function shutterEnvironment(edgeUrl: string): ShutterEnvironment {
  return {
    SHUTTER_CAPABILITY_KEYS: "",
    SHUTTER_CAPABILITY_KID: "",
    SHUTTER_CONTROL_URL: "",
    SHUTTER_EDGE_URL: edgeUrl,
    SHUTTER_SPACE_API_TOKEN: "",
    SHUTTER_SPACE_ID: "",
  };
}

function trackingDependencies(edgeUrl: string) {
  const calls: string[] = [];
  const signedRequests: { expiresInSeconds: number; key: string }[] = [];
  const dependencies: VariantProviderDependencies = {
    createSignedOriginalUrl: async (request) => {
      calls.push("signed-original");
      signedRequests.push(request);
      return `https://storage.example/${request.key}?signed`;
    },
    environment: shutterEnvironment(edgeUrl),
    resolveShutterImageUrl: async () => {
      calls.push("shutter-image");
      return "https://edge.example/variant";
    },
    resolveShutterPreview: async () => {
      calls.push("shutter-preview");
      return { status: "ready", url: "https://edge.example/preview" };
    },
  };
  return { calls, dependencies, signedRequests };
}

describe("isShutterConfigured", () => {
  it("is false when SHUTTER_EDGE_URL is unset", () => {
    expect(isShutterConfigured(shutterEnvironment(""))).toBe(false);
  });

  it("is true when SHUTTER_EDGE_URL is set", () => {
    expect(isShutterConfigured(shutterEnvironment("https://edge.example"))).toBe(true);
  });
});

describe("resolveVariantImageUrl", () => {
  it("passes through to a day-long signed original URL without Shutter", async () => {
    const { calls, dependencies, signedRequests } = trackingDependencies("");

    const url = await resolveVariantImageUrl(context, 320, dependencies);

    expect(url).toBe(`https://storage.example/${context.originalObjectKey}?signed`);
    expect(calls).toEqual(["signed-original"]);
    expect(signedRequests).toEqual([
      { expiresInSeconds: 24 * 60 * 60, key: context.originalObjectKey },
    ]);
  });

  it("delegates to Shutter when configured", async () => {
    const { calls, dependencies } = trackingDependencies("https://edge.example");

    const url = await resolveVariantImageUrl(context, 320, dependencies);

    expect(url).toBe("https://edge.example/variant");
    expect(calls).toEqual(["shutter-image"]);
  });
});

describe("resolveVariantPreview", () => {
  it("fails previews without Shutter instead of serving full originals", async () => {
    const { calls, dependencies } = trackingDependencies("");
    const video: MediaThumbnailContext = { ...context, extension: "mp4", mediaType: "video" };

    const preview = await resolveVariantPreview(video, 960, dependencies);

    expect(preview).toEqual({ status: "failed" });
    expect(calls).toEqual([]);
  });

  it("delegates to Shutter when configured", async () => {
    const { calls, dependencies } = trackingDependencies("https://edge.example");
    const video: MediaThumbnailContext = { ...context, extension: "mp4", mediaType: "video" };

    const preview = await resolveVariantPreview(video, 960, dependencies);

    expect(preview).toEqual({ status: "ready", url: "https://edge.example/preview" });
    expect(calls).toEqual(["shutter-preview"]);
  });
});
