import {
  createS3StorageClient,
  createSignedGetUrl,
} from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env/server";
import { isRequestSessionValid } from "../server/auth/web-session-core";
import { planSignedStoredMediaDelivery } from "../server/media/delivery";
import { readThumbnailDeliveryRequest } from "../server/media/repository";

const defaultThumbnailSize = 320;

export const Route = createFileRoute("/api/media/$mediaId/thumbnail")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        if (!(await isRequestSessionValid({ request }))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const media = await readThumbnailDeliveryRequest({
          mediaId: params.mediaId,
          size: readThumbnailSize(request),
        });

        if (!media) {
          return new Response("Thumbnail not found", { status: 404 });
        }

        const delivery = planSignedStoredMediaDelivery(media);
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
          headers: { Location: signedUrl },
          status: 302,
        });
      },
    },
  },
});

function readThumbnailSize(request: Request): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : defaultThumbnailSize;
  return Number.isInteger(size) && size > 0 ? size : defaultThumbnailSize;
}
