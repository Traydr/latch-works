import { type MediaThumbnailContext, readMediaThumbnailContext } from "./repository";
import type { ShutterPreviewResult } from "./shutter-client";
import { resolveVariantImageUrl, resolveVariantPreview } from "./variant-provider";

const API_PRIVATE_CACHE_CONTROL = "private, no-store";

/** The archive read and the two Shutter reads a variant redirect makes. */
export interface ShutterRedirectDependencies {
  readThumbnailContext(request: { mediaId: string }): Promise<MediaThumbnailContext | null>;
  resolveImageUrl(context: MediaThumbnailContext, width: number): Promise<string>;
  resolvePreview(context: MediaThumbnailContext, width: number): Promise<ShutterPreviewResult>;
}

const defaultShutterRedirectDependencies: ShutterRedirectDependencies = {
  readThumbnailContext: readMediaThumbnailContext,
  resolveImageUrl: resolveVariantImageUrl,
  resolvePreview: resolveVariantPreview,
};

export function readDeliverySizeFromRequest(request: Request, fallback: number): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : fallback;
  return Number.isInteger(size) && size > 0 ? size : fallback;
}

export async function redirectToMediaVariant(
  { mediaId, width }: { mediaId: string; width: number },
  dependencies: ShutterRedirectDependencies = defaultShutterRedirectDependencies,
): Promise<Response> {
  const context = await dependencies.readThumbnailContext({ mediaId });
  if (!context) {
    return new Response("Media not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  if (context.mediaType === "image" || context.mediaType === "gif") {
    try {
      const location = await dependencies.resolveImageUrl(context, width);
      return new Response(null, {
        headers: {
          "Cache-Control": API_PRIVATE_CACHE_CONTROL,
          Location: location,
        },
        status: 302,
      });
    } catch {
      return new Response("Thumbnail unavailable", {
        headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
        status: 502,
      });
    }
  }

  if (context.mediaType !== "video" && context.mediaType !== "pdf") {
    return new Response("Variant not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  let preview: ShutterPreviewResult;
  try {
    preview = await dependencies.resolvePreview(context, width);
  } catch {
    return new Response("Preview unavailable", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 502,
    });
  }
  if (preview.status === "pending") {
    return new Response("Preview is being generated", {
      headers: {
        "Cache-Control": API_PRIVATE_CACHE_CONTROL,
        "Retry-After": String(Math.max(1, Math.ceil(preview.retryAfterMs / 1_000))),
      },
      status: 503,
    });
  }

  if (preview.status === "failed") {
    return new Response("Preview not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: preview.url,
    },
    status: 302,
  });
}
