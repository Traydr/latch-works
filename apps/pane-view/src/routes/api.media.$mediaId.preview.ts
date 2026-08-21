import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import {
  readDeliverySizeFromRequest,
  redirectToMediaVariant,
} from "../server/media/shutter-delivery-redirect";

const API_PRIVATE_CACHE_CONTROL = "private, no-store";
const DEFAULT_PREVIEW_WIDTH = 960;

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

        return redirectToMediaVariant({
          mediaId: params.mediaId,
          width: readDeliverySizeFromRequest(request, DEFAULT_PREVIEW_WIDTH),
        });
      },
    },
  },
});
