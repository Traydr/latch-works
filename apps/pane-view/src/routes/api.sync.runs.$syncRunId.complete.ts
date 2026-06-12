import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { finalizeSyncRun } from "../server/sync/store";

export const Route = createFileRoute("/api/sync/runs/$syncRunId/complete")({
  server: {
    handlers: {
      POST: async ({
        params,
        request,
      }: {
        params: { syncRunId: string };
        request: Request;
      }) => {
        const unauthorized = requireSyncApiToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        const body = (await request.json().catch(() => ({}))) as {
          counts?: Record<string, number>;
          error?: string;
          status?: string;
        };

        if (
          body.status !== "completed" &&
          body.status !== "failed" &&
          body.status !== "cancelled"
        ) {
          return Response.json(
            { error: "status must be completed, failed, or cancelled" },
            { status: 400 },
          );
        }

        return Response.json(
          await finalizeSyncRun({
            input: {
              counts: body.counts,
              error: typeof body.error === "string" ? body.error : undefined,
              status: body.status,
              syncRunId: params.syncRunId,
            },
          }),
        );
      },
    },
  },
});
