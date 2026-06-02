import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request, process.env);
        if (unauthorized) {
          return unauthorized;
        }

        return Response.json({
          status: "pending-database-adapter",
        });
      },
    },
  },
});
