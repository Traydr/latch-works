import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSyncApiToken } from "../server/auth/api-token";
import { readJsonBody } from "../server/http/json-body";
import { finalizeSyncRun } from "../server/sync/store";
import { SyncRunCountsSchema } from "../server/sync/validation";

const FinalizeSyncRunBodySchema = z.object({
  counts: SyncRunCountsSchema.optional(),
  error: z.string({ error: "error must be a string" }).optional(),
  status: z.enum(["completed", "failed", "cancelled"], {
    error: "status must be completed, failed, or cancelled",
  }),
});

export async function postSyncRunComplete({
  params,
  request,
}: {
  params: { syncRunId: string };
  request: Request;
}): Promise<Response> {
  const unauthorized = requireSyncApiToken(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = await readJsonBody(request, FinalizeSyncRunBodySchema);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  return Response.json(
    await finalizeSyncRun({
      input: {
        counts: parsed.body.counts,
        error: parsed.body.error,
        status: parsed.body.status,
        syncRunId: params.syncRunId,
      },
    }),
  );
}

export const Route = createFileRoute("/api/sync/runs/$syncRunId/complete")({
  server: {
    handlers: { POST: postSyncRunComplete },
  },
});
