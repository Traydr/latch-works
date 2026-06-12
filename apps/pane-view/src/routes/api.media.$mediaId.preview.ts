import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { API_PRIVATE_CACHE_CONTROL } from "../server/media/cdn-delivery";
import { redirectToCdnDelivery } from "../server/media/delivery-redirect";
import { ensurePreviewDerivative } from "../server/media/derivative-service";
import { readMediaThumbnailContext } from "../server/media/repository";

export const Route = createFileRoute("/api/media/$mediaId/preview")({
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

        const result = await ensurePreviewDerivative({ mediaId: params.mediaId });
        if (result.status === "pending") {
          return new Response("Preview is being generated", {
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

          return new Response("Preview not found", {
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
