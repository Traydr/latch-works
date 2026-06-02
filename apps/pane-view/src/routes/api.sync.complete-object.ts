import { MediaTypeSchema } from "@latch-works/media-domain";
import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { completeSyncedObject, markRemoteDeleted } from "../server/sync/store";

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request, process.env);
        if (unauthorized) {
          return unauthorized;
        }

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        if (body.action === "delete") {
          if (typeof body.logicalPath !== "string" || typeof body.syncRunId !== "string") {
            return Response.json(
              { error: "logicalPath and syncRunId are required" },
              { status: 400 },
            );
          }

          return Response.json(
            await markRemoteDeleted({
              env: process.env,
              logicalPath: body.logicalPath,
              syncRunId: body.syncRunId,
            }),
          );
        }

        const required = [
          "contentType",
          "extension",
          "filename",
          "logicalPath",
          "mediaType",
          "mtimeMs",
          "sha256",
          "size",
          "syncRunId",
        ] as const;
        for (const key of required) {
          if (body[key] === undefined) {
            return Response.json({ error: `${key} is required` }, { status: 400 });
          }
        }
        const mediaType = MediaTypeSchema.safeParse(body.mediaType);
        if (!mediaType.success) {
          return Response.json({ error: "mediaType is invalid" }, { status: 400 });
        }

        return Response.json(
          await completeSyncedObject({
            env: process.env,
            input: {
              contentType: String(body.contentType),
              extension: String(body.extension),
              filename: String(body.filename),
              logicalPath: String(body.logicalPath),
              mediaType: mediaType.data,
              mtimeMs: Number(body.mtimeMs),
              objectKey: typeof body.objectKey === "string" ? body.objectKey : undefined,
              sha256: String(body.sha256),
              size: Number(body.size),
              syncRunId: String(body.syncRunId),
            },
          }),
        );
      },
    },
  },
});
