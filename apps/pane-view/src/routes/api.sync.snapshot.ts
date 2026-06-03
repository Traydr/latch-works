import { createFileRoute } from "@tanstack/react-router";
import { requireSyncApiToken } from "../server/auth/api-token";
import { listRemoteSyncSnapshot } from "../server/sync/store";

export const Route = createFileRoute("/api/sync/snapshot")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const unauthorized = requireSyncApiToken(request);
        if (unauthorized) {
          return unauthorized;
        }

        return Response.json(await listRemoteSyncSnapshot());
      },
    },
  },
});
