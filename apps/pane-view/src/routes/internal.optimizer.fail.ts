import { createFileRoute } from "@tanstack/react-router";
import { requireOptimizerToken } from "../server/auth/optimizer-token";
import { logDerivativeEvent } from "../server/media/derivative-telemetry";
import { failOptimizerJob, failRequestSchema } from "../server/media/optimizer-jobs-service";

export const Route = createFileRoute("/internal/optimizer/fail")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireOptimizerToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        const body = await request.json().catch(() => ({}));
        const parsed = failRequestSchema.safeParse(body);
        if (!parsed.success) {
          logDerivativeEvent("optimizer.fail_invalid", { issueCount: parsed.error.issues.length });
          return Response.json({ error: "Invalid fail request" }, { status: 400 });
        }

        const result = await failOptimizerJob(parsed.data);
        return Response.json(result, { status: result.matched ? 200 : 409 });
      },
    },
  },
});
