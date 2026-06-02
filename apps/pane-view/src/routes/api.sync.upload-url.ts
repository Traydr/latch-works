import { detectMediaType, getExtension } from "@latch-works/media-domain";
import { originalObjectKey } from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";

interface UploadUrlRequest {
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

        return Response.json({
          objectKey: originalObjectKey({
            extension: getExtension(body.filename),
            mediaType,
            sha256: body.sha256,
          }),
          status: "pending-storage-adapter",
          uploadUrl: null,
        });
      },
    },
  },
});
