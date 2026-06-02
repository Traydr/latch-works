import {
  createS3StorageClient,
  createSignedGetUrl,
  readS3StorageConfig,
} from "@latch-works/media-storage";
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

        // TODO: Resolve mediaId from Postgres instead of this placeholder object.
        const delivery = planSignedOriginalDelivery({
          extension: "jpg",
          mediaType: "image",
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        });
        const storageConfig = readS3StorageConfig(process.env);

        if (storageConfig) {
          const storage = createS3StorageClient(storageConfig);
          const signedUrl = await createSignedGetUrl({
            expiresInSeconds: delivery.expiresInSeconds,
            key: delivery.objectKey,
            storage,
          });

          return new Response(null, {
            headers: { Location: signedUrl },
            status: 302,
          });
        }

        return Response.json({
          mediaId: params.mediaId,
          ...delivery,
          status: "pending-storage-adapter",
        });
      },
    },
  },
});
