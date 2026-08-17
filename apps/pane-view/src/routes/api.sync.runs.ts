import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireSyncApiToken } from "../server/auth/api-token";
import { readJsonBody } from "../server/http/json-body";
import { startSyncRun } from "../server/sync/store";
import { SyncRunCountsSchema } from "../server/sync/validation";

const StartSyncRunBodySchema = z.object({
  counts: SyncRunCountsSchema.optional(),
  sourceRoot: z.string({ error: "sourceRoot must be a string" }).optional(),
});

export async function postSyncRuns({ request }: { request: Request }): Promise<Response> {
  const unauthorized = requireSyncApiToken(request);
  if (unauthorized) {
    return unauthorized;
  }

  const parsed = await readJsonBody(request, StartSyncRunBodySchema);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const syncRun = await startSyncRun({
    input: {
      counts: parsed.body.counts,
      sourceRoot: parsed.body.sourceRoot ?? "unknown",
    },
  });

  return Response.json(syncRun);
}

export const Route = createFileRoute("/api/sync/runs")({
  server: {
    handlers: { POST: postSyncRuns },
  },
});
