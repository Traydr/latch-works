import { createSignedGetUrl } from "@latch-works/media-storage";
import { env } from "../../env/server";
import type { MediaThumbnailContext } from "./repository";
import {
  resolveShutterImageUrl,
  resolveShutterPreview,
  type ShutterEnvironment,
  type ShutterPreviewResult,
} from "./shutter-client";
import { createPaneViewStorageClient } from "./storage-client";

/**
 * Pass-through URLs must outlive the client caches, which assume variant
 * URLs are good for a day (the Shutter capability lifetime). A shorter expiry
 * would 403 while the batch resolver keeps serving the cached URL.
 */
const PASS_THROUGH_URL_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * What a variant resolution needs from outside: the Shutter configuration,
 * the Shutter resolvers, and a way to sign a GET for the original object.
 */
export interface VariantProviderDependencies {
  createSignedOriginalUrl(request: { expiresInSeconds: number; key: string }): Promise<string>;
  environment: ShutterEnvironment;
  resolveShutterImageUrl(context: MediaThumbnailContext, width: number): Promise<string>;
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
    expiresInSeconds: PASS_THROUGH_URL_LIFETIME_SECONDS,
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
