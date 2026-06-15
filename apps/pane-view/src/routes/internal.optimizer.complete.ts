import { createFileRoute } from "@tanstack/react-router";
import { requireOptimizerToken } from "../server/auth/optimizer-token";
import {
  completeOptimizerJob,
  completeRequestSchema,
} from "../server/media/optimizer-jobs-service";

export const Route = createFileRoute("/internal/optimizer/complete")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireOptimizerToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        const body = await request.json().catch(() => ({}));
        const parsed = completeRequestSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "Invalid complete request" }, { status: 400 });
        }

        const result = await completeOptimizerJob(parsed.data);
        return Response.json(result, { status: result.matched ? 200 : 409 });
      },
    },
  },
});
