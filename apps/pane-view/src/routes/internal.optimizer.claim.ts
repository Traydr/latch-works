import { createFileRoute } from "@tanstack/react-router";
import { requireOptimizerToken } from "../server/auth/optimizer-token";
import { claimOptimizerJobs, claimRequestSchema } from "../server/media/optimizer-jobs-service";

export const Route = createFileRoute("/internal/optimizer/claim")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireOptimizerToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        const body = await request.json().catch(() => ({}));
        const parsed = claimRequestSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "Invalid claim request" }, { status: 400 });
        }

        return Response.json(await claimOptimizerJobs(parsed.data));
      },
    },
  },
});
