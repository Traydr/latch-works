import { snapThumbnailSize } from "@latch-works/media-delivery";
import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { API_PRIVATE_CACHE_CONTROL } from "../server/media/cdn-delivery";
import { redirectToCdnDelivery } from "../server/media/delivery-redirect";
import { ensureThumbnailDerivative } from "../server/media/derivative-service";
import { readMediaThumbnailContext } from "../server/media/repository";

const defaultThumbnailSize = 320;

export const Route = createFileRoute("/api/media/$mediaId/thumbnail")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        if (!(await isRequestSessionValid({ request }))) {
          return new Response("Unauthorized", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 401,
          });
        }

        const media = await readMediaThumbnailContext({ mediaId: params.mediaId });
        if (!media) {
          return new Response("Media not found", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 404,
          });
        }

        const size = snapThumbnailSize(readThumbnailSize(request));
        const result = await ensureThumbnailDerivative({
          mediaId: params.mediaId,
          requestedSize: size,
        });

        if (result.status === "pending") {
          return new Response("Thumbnail is being generated", {
            headers: {
              "Cache-Control": API_PRIVATE_CACHE_CONTROL,
              "Retry-After": "1",
            },
            status: 503,
          });
        }

        if (result.status === "failed" || result.status === "unsupported") {
          if (media.mediaType === "image" || media.mediaType === "gif") {
            return redirectToOriginal(params.mediaId);
          }

          return new Response("Thumbnail not found", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 404,
          });
        }

        return await redirectToCdnDelivery({ objectKey: result.objectKey });
      },
    },
  },
});

function redirectToOriginal(mediaId: string): Response {
  return new Response(null, {
    headers: {
      "Cache-Control": API_PRIVATE_CACHE_CONTROL,
      Location: `/api/media/${mediaId}/original`,
    },
    status: 302,
  });
}

function readThumbnailSize(request: Request): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : defaultThumbnailSize;
  return Number.isInteger(size) && size > 0 ? size : defaultThumbnailSize;
}
