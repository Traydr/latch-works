import { createSignedGetUrl } from "@latch-works/media-storage";
import { env } from "../../env/server";
import {
  type MediaDeliveryRequest,
  planOriginalDelivery,
  SIGNED_URL_LIFETIME_SECONDS,
} from "./delivery";
import type { MediaThumbnailContext } from "./repository";
import {
  resolveShutterImageUrl,
  resolveShutterOriginalUrl,
  resolveShutterPreview,
  type ShutterEnvironment,
  type ShutterOriginalSource,
  type ShutterPreviewResult,
} from "./shutter-client";
import { createPaneViewStorageClient } from "./storage-client";

/**
 * What a variant resolution needs from outside: the Shutter configuration,
 * the Shutter resolvers, and a way to sign a GET for the original object.
 */
export interface VariantProviderDependencies {
  createSignedOriginalUrl(request: { expiresInSeconds: number; key: string }): Promise<string>;
  environment: ShutterEnvironment;
  resolveShutterImageUrl(context: MediaThumbnailContext, width: number): Promise<string>;
  resolveShutterOriginalUrl(source: ShutterOriginalSource): Promise<string>;
  resolveShutterPreview(
    context: MediaThumbnailContext,
    width: number,
  ): Promise<ShutterPreviewResult>;
}

const defaultVariantProviderDependencies: VariantProviderDependencies = {
  createSignedOriginalUrl: (request) =>
    createSignedGetUrl({ ...request, storage: createPaneViewStorageClient() }),
  environment: env,
  resolveShutterImageUrl,
  resolveShutterOriginalUrl,
  resolveShutterPreview,
};

/**
 * Shutter is opt-in: an unset SHUTTER_EDGE_URL means variants pass through
 * to signed original URLs. A set-but-misconfigured Shutter still surfaces as
 * an error rather than silently degrading to full-size originals.
 */
export function isShutterConfigured(environment: ShutterEnvironment = env): boolean {
  return environment.SHUTTER_EDGE_URL !== "";
}

export async function resolveVariantImageUrl(
  context: MediaThumbnailContext,
  width: number,
  dependencies: VariantProviderDependencies = defaultVariantProviderDependencies,
): Promise<string> {
  if (isShutterConfigured(dependencies.environment)) {
    return dependencies.resolveShutterImageUrl(context, width);
  }

  // The pass-through serves the original bytes, so the requested width is moot.
  return dependencies.createSignedOriginalUrl({
    expiresInSeconds: SIGNED_URL_LIFETIME_SECONDS,
    key: context.originalObjectKey,
  });
}

export async function resolveVariantPreview(
  context: MediaThumbnailContext,
  width: number,
  dependencies: VariantProviderDependencies = defaultVariantProviderDependencies,
): Promise<ShutterPreviewResult> {
  if (isShutterConfigured(dependencies.environment)) {
    return dependencies.resolveShutterPreview(context, width);
  }

  // Video and PDF stills require Shutter; without it the tile falls back to a
  // placeholder while the viewer keeps playing the signed original.
  return { status: "failed" };
}

/**
 * The original itself: playback, the PDF viewer, and the download link. It
 * goes through Shutter when Shutter is on and passes the object's content
 * type through, so the Cloudflare edge answers repeat plays and seeks; the
 * rest is a signed bucket URL, as before.
 */
export async function resolveVariantOriginalUrl(
  request: MediaDeliveryRequest,
  dependencies: VariantProviderDependencies = defaultVariantProviderDependencies,
): Promise<string> {
  const plan = planOriginalDelivery(request, {
    shutter: isShutterConfigured(dependencies.environment),
  });

  if (plan.strategy === "shutter") {
    return dependencies.resolveShutterOriginalUrl({
      originalObjectKey: plan.objectKey,
      sha256: plan.sha256,
    });
  }

  return dependencies.createSignedOriginalUrl({
    expiresInSeconds: plan.expiresInSeconds,
    key: plan.objectKey,
  });
}
