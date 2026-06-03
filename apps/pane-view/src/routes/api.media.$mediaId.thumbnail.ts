import {
  createS3StorageClient,
  createSignedGetUrl,
  readS3StorageConfig,
} from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { readCookie, sessionCookieName } from "../server/auth/session";
import { isStoredSessionValid } from "../server/auth/session-store";
import { planSignedStoredMediaDelivery } from "../server/media/delivery";
import { readThumbnailDeliveryRequest } from "../server/media/repository";

const defaultThumbnailSize = 320;

export const Route = createFileRoute("/api/media/$mediaId/thumbnail")({
  server: {
    handlers: {
      GET: async ({ params, request }: { params: { mediaId: string }; request: Request }) => {
        const sessionToken = readCookie(request.headers.get("Cookie"), sessionCookieName);
        if (!(await isStoredSessionValid({ env: process.env, token: sessionToken }))) {
          return new Response("Unauthorized", { status: 401 });
        }

        const media = await readThumbnailDeliveryRequest({
          env: process.env,
          mediaId: params.mediaId,
          size: readThumbnailSize(request),
        });

        if (!media) {
          return new Response("Thumbnail not found", { status: 404 });
        }

        const delivery = planSignedStoredMediaDelivery(media);
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

function readThumbnailSize(request: Request): number {
  const rawSize = new URL(request.url).searchParams.get("size");
  const size = rawSize ? Number(rawSize) : defaultThumbnailSize;
  return Number.isInteger(size) && size > 0 ? size : defaultThumbnailSize;
}
