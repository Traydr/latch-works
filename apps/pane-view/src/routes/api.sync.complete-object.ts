import { createFileRoute } from "@tanstack/react-router";
import { readJsonBody } from "../server/http/json-body";
import {
  type SyncRouteDependencies,
  syncRouteDependencies,
} from "../server/sync/route-dependencies";
import { CompleteObjectBodySchema, validateSyncObjectPayload } from "../server/sync/validation";

export async function postCompleteObject(
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

  const parsed = await readJsonBody(request, CompleteObjectBodySchema);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.body;

  if (body.action === "delete") {
    return Response.json(
      await dependencies.markRemoteDeleted({
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
    await dependencies.completeSyncedObject({
      input: validated.input,
    }),
  );
}

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: { POST: postCompleteObject },
  },
});
