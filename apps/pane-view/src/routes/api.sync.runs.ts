import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { startSyncRun } from "../server/sync/store";

export const Route = createFileRoute("/api/sync/runs")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request, process.env);
        if (unauthorized) {
          return unauthorized;
        }

        const body = (await request.json().catch(() => ({}))) as {
          counts?: Record<string, number>;
          sourceRoot?: string;
        };
        const syncRun = await startSyncRun({
          env: process.env,
          input: {
            counts: body.counts,
            sourceRoot: body.sourceRoot ?? "unknown",
          },
        });

        return Response.json(syncRun);
      },
    },
  },
});
