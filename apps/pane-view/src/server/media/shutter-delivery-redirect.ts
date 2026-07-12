import { readMediaThumbnailContext } from "./repository";
import { resolveShutterImageUrl, resolveShutterPreview } from "./shutter-client";

const API_PRIVATE_CACHE_CONTROL = "private, no-store";

export function readDeliverySizeFromRequest(request: Request, fallback: number): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : fallback;
  return Number.isInteger(size) && size > 0 ? size : fallback;
}

export async function redirectToShutterRendition({
  mediaId,
  width,
}: {
  mediaId: string;
  width: number;
}): Promise<Response> {
  const context = await readMediaThumbnailContext({ mediaId });
  if (!context) {
    return new Response("Media not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  if (context.mediaType === "image" || context.mediaType === "gif") {
    try {
      const location = await resolveShutterImageUrl(context, width);
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
    return new Response("Rendition not found", {
      headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
      status: 404,
    });
  }

  const preview = await resolveShutterPreview(context, width);
  if (preview.status === "pending") {
    return new Response("Rendition is being generated", {
      headers: {
        "Cache-Control": API_PRIVATE_CACHE_CONTROL,
        "Retry-After": String(Math.max(1, Math.ceil(preview.retryAfterMs / 1_000))),
      },
      status: 503,
    });
  }

  if (preview.status === "failed") {
    return new Response("Rendition not found", {
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
