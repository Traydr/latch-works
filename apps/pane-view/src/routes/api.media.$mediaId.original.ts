import { createFileRoute } from "@tanstack/react-router";
import { readCookie, sessionCookieName } from "../server/auth/session";
import { planSignedOriginalDelivery } from "../server/media/delivery";

export const Route = createFileRoute("/api/media/$mediaId/original")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        const sessionToken = readCookie(request.headers.get("Cookie"), sessionCookieName);
        if (!sessionToken) {
          return new Response("Unauthorized", { status: 401 });
        }

        // TODO: Resolve mediaId from Postgres and issue a real Railway Bucket signed URL.
        const delivery = planSignedOriginalDelivery({
          extension: "jpg",
          mediaType: "image",
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        });

        return Response.json({
          mediaId: params.mediaId,
          ...delivery,
          status: "pending-storage-adapter",
        });
      },
    },
  },
});
