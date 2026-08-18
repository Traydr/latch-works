import { getExtension } from "@latch-works/media-domain";
import { originalObjectKey } from "@latch-works/media-storage";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readJsonBody } from "../server/http/json-body";
import {
  type SyncRouteDependencies,
  syncRouteDependencies,
} from "../server/sync/route-dependencies";
import {
  expectedContentTypeForExtension,
  MAX_SYNC_UPLOAD_BYTES,
  UploadSizeSchema,
  validateSyncContentType,
  validateUploadFilename,
} from "../server/sync/validation";

const UploadUrlBodySchema = z.object({
  filename: z.string({ error: "filename and sha256 are required" }).min(1, {
    error: "filename and sha256 are required",
  }),
  sha256: z.string({ error: "filename and sha256 are required" }).min(1, {
    error: "filename and sha256 are required",
  }),
  size: UploadSizeSchema,
  contentType: z.string({ error: "contentType must be a string" }).optional(),
});

export async function postUploadUrl(
  { request }: { request: Request },
  dependencies: SyncRouteDependencies = syncRouteDependencies,
): Promise<Response> {
  const unauthorized = dependencies.requireSyncApiToken(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    await dependencies.assertNoActiveCleanupJob();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Library wipe is active." },
      { status: 409 },
    );
  }

  const parsed = await readJsonBody(request, UploadUrlBodySchema);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.body;

  const filenameError = validateUploadFilename(body.filename);
  if (filenameError) {
    return Response.json({ error: filenameError }, { status: 400 });
  }

  const extension = getExtension(body.filename);
  const contentType = expectedContentTypeForExtension(extension);
  if (body.contentType !== undefined) {
    const contentTypeError = validateSyncContentType(extension, body.contentType);
    if (contentTypeError) {
      return Response.json({ error: contentTypeError }, { status: 400 });
    }
  }

  const size = body.size;

  const objectKey = originalObjectKey({
    extension,
    sha256: body.sha256,
  });
  const signed = await dependencies.createSignedUploadUrl({
    contentLength: size,
    contentType,
    key: objectKey,
    sha256: body.sha256,
  });

  return Response.json({
    headers: signed.headers,
    maxUploadBytes: MAX_SYNC_UPLOAD_BYTES,
    objectKey,
    status: "signed-url-ready",
    uploadUrl: signed.uploadUrl,
  });
}

export const Route = createFileRoute("/api/sync/upload-url")({
  server: {
    handlers: { POST: postUploadUrl },
  },
});
