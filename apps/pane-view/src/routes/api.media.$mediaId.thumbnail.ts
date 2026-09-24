import { createFileRoute } from "@tanstack/react-router";
import { redirectToMediaDelivery } from "../server/media/delivery-redirect";

export const Route = createFileRoute("/api/media/$mediaId/thumbnail")({
  server: {
    handlers: {
      GET: ({ params, request }: { params: { mediaId: string }; request: Request }) =>
        redirectToMediaDelivery({ mediaId: params.mediaId, request, variant: "thumbnail" }),
    },
  },
});
