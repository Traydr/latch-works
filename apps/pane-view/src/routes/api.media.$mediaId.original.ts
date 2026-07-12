import { createS3StorageClient, createSignedGetUrl } from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env/server";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { planSignedOriginalDelivery } from "../server/media/delivery";
import { readMediaDeliveryRequest } from "../server/media/repository";

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

        const delivery = planSignedOriginalDelivery(media);
        const signedUrl = await createSignedGetUrl({
          expiresInSeconds: delivery.expiresInSeconds,
          key: delivery.objectKey,
          storage: createS3StorageClient({
            accessKeyId: env.S3_ACCESS_KEY_ID,
            bucket: env.S3_BUCKET,
            endpoint: env.S3_ENDPOINT,
            region: env.S3_REGION,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }),
        });

        return new Response(null, {
          headers: {
            "Cache-Control": API_PRIVATE_CACHE_CONTROL,
            Location: signedUrl,
          },
          status: 302,
        });
      },
    },
  },
});
