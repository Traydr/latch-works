import { snapThumbnailSize } from "@latch-works/media-delivery";
import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { API_PRIVATE_CACHE_CONTROL, buildSignedCdnDeliveryUrl } from "../server/media/cdn-delivery";
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
          return new Response("Thumbnail not found", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 404,
          });
        }

        const deliveryUrl = buildSignedCdnDeliveryUrl({
          objectKey: result.objectKey,
          purpose: result.purpose,
        });

        return new Response(null, {
          headers: {
            "Cache-Control": API_PRIVATE_CACHE_CONTROL,
            Location: deliveryUrl,
          },
          status: 302,
        });
      },
    },
  },
});

function readThumbnailSize(request: Request): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : defaultThumbnailSize;
  return Number.isInteger(size) && size > 0 ? size : defaultThumbnailSize;
}
