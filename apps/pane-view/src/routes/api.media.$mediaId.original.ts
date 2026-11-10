import { createFileRoute } from "@tanstack/react-router";
import { redirectToOriginal } from "../server/media/delivery-redirect";

export const Route = createFileRoute("/api/media/$mediaId/original")({
  server: {
    handlers: {
      GET: ({ params, request }: { params: { mediaId: string }; request: Request }) =>
        redirectToOriginal({ mediaId: params.mediaId, request }),
    },
  },
});
