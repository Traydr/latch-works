import { detectMediaType, getExtension } from "@latch-works/media-domain";
import {
  createS3StorageClient,
  createSignedPutUrl,
  originalObjectKey,
  readS3StorageConfig,
} from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";

interface UploadUrlRequest {
  contentType?: string;
  filename?: string;
  sha256?: string;
}

export const Route = createFileRoute("/api/sync/upload-url")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request, process.env);
        if (unauthorized) {
          return unauthorized;
        }

        const body = (await request.json().catch(() => ({}))) as UploadUrlRequest;
        if (!body.filename || !body.sha256) {
          return Response.json({ error: "filename and sha256 are required" }, { status: 400 });
        }

        const mediaType = detectMediaType(body.filename);
        if (!mediaType) {
          return Response.json({ error: "unsupported media filename" }, { status: 400 });
        }

        const objectKey = originalObjectKey({
          extension: getExtension(body.filename),
          mediaType,
          sha256: body.sha256,
        });
        const storageConfig = readS3StorageConfig(process.env);
        const uploadUrl = storageConfig
          ? await createSignedPutUrl({
              contentType: body.contentType ?? "application/octet-stream",
              key: objectKey,
              storage: createS3StorageClient(storageConfig),
            })
          : null;

        return Response.json({
          objectKey,
          status: storageConfig ? "signed-url-ready" : "pending-storage-adapter",
          uploadUrl,
        });
      },
    },
  },
});
