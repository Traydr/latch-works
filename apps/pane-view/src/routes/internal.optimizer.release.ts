import { createFileRoute } from "@tanstack/react-router";
import { requireOptimizerToken } from "../server/auth/optimizer-token";
import { logDerivativeEvent } from "../server/media/derivative-telemetry";
import { releaseOptimizerJobs, releaseRequestSchema } from "../server/media/optimizer-jobs-service";

export const Route = createFileRoute("/internal/optimizer/release")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireOptimizerToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        const body = await request.json().catch(() => ({}));
        const parsed = releaseRequestSchema.safeParse(body);
        if (!parsed.success) {
          logDerivativeEvent("optimizer.release_invalid", {
            issueCount: parsed.error.issues.length,
          });
          return Response.json({ error: "Invalid release request" }, { status: 400 });
        }

        return Response.json(await releaseOptimizerJobs(parsed.data));
      },
    },
  },
});
