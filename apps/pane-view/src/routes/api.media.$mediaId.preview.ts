import { createFileRoute } from "@tanstack/react-router";
import { redirectToMediaDelivery } from "../server/media/delivery-redirect";

export const Route = createFileRoute("/api/media/$mediaId/preview")({
  server: {
    handlers: {
      GET: ({ params, request }: { params: { mediaId: string }; request: Request }) =>
        redirectToMediaDelivery({ mediaId: params.mediaId, request, variant: "preview" }),
    },
  },
});
