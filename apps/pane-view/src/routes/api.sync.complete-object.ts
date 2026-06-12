import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { completeSyncedObject, markRemoteDeleted } from "../server/sync/store";
import { validateSyncObjectPayload } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request);
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
              logicalPath: body.logicalPath,
              syncRunId: body.syncRunId,
            }),
          );
        }

        const validated = validateSyncObjectPayload(body);
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: 400 });
        }

        return Response.json(
          await completeSyncedObject({
            input: validated.input,
          }),
        );
      },
    },
  },
});
