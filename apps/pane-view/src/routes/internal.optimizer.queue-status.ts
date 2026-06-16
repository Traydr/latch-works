import { createFileRoute } from "@tanstack/react-router";
import { requireOptimizerToken } from "../server/auth/optimizer-token";
import { readOptimizerQueueStatus } from "../server/media/optimizer-queue-status";

export const Route = createFileRoute("/internal/optimizer/queue-status")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const unauthorized = requireOptimizerToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        return Response.json(await readOptimizerQueueStatus());
      },
    },
  },
});
