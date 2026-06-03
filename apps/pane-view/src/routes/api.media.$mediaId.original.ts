import {
  createS3StorageClient,
  createSignedGetUrl,
  readS3StorageConfig,
} from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { planSignedOriginalDelivery } from "../server/media/delivery";
import { readMediaDeliveryRequest } from "../server/media/repository";

export const Route = createFileRoute("/api/media/$mediaId/original")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        if (!(await isRequestSessionValid({ request }))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const media = await readMediaDeliveryRequest({
          env: process.env,
          mediaId: params.mediaId,
        });

        if (!media) {
          return new Response("Media not found", { status: 404 });
        }

        const delivery = planSignedOriginalDelivery(media);
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
