import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { readJsonBody } from "../server/http/json-body";
import { assertNoActiveCleanupJob } from "../server/management/guards";
import { completeSyncedObject, markRemoteDeleted } from "../server/sync/store";
import { CompleteObjectBodySchema, validateSyncObjectPayload } from "../server/sync/validation";

export async function postCompleteObject({ request }: { request: Request }): Promise<Response> {
  const unauthorized = requireSyncApiToken(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    await assertNoActiveCleanupJob();
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
}

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: { POST: postCompleteObject },
  },
});
