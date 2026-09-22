import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { readMediaDeliveryRequest } from "../server/media/repository";
import { resolveVariantOriginalUrl } from "../server/media/variant-provider";

const API_PRIVATE_CACHE_CONTROL = "private, no-store";

export const Route = createFileRoute("/api/media/$mediaId/original")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        if (!(await isRequestSessionValid({ request }))) {
          return new Response("Unauthorized", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 401,
          });
        }

        const media = await readMediaDeliveryRequest({
          mediaId: params.mediaId,
        });

        if (!media) {
          return new Response("Media not found", { status: 404 });
        }

        let location: string;

        try {
          location = await resolveVariantOriginalUrl(media);
        } catch {
          return new Response("Original unavailable", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 502,
          });
        }

        return new Response(null, {
          headers: {
            "Cache-Control": API_PRIVATE_CACHE_CONTROL,
            Location: location,
          },
          status: 302,
        });
      },
    },
  },
});
