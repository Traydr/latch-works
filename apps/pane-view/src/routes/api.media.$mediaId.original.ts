import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
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

        // A media id that is not a UUID names no entry; don't hand it to Postgres.
        const media = z.uuid().safeParse(params.mediaId).success
          ? await readMediaDeliveryRequest({ mediaId: params.mediaId })
          : null;

        if (!media) {
          return new Response("Media not found", {
            headers: { "Cache-Control": API_PRIVATE_CACHE_CONTROL },
            status: 404,
          });
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
