import { createFileRoute } from "@tanstack/react-router";
import { withHttpErrors } from "../server/http/http-error";
import {
  type SyncRouteDependencies,
  syncRouteDependencies,
} from "../server/sync/route-dependencies";

export async function getSyncSnapshot(
  { request }: { request: Request },
  dependencies: SyncRouteDependencies = syncRouteDependencies,
): Promise<Response> {
  const unauthorized = dependencies.requireSyncApiToken(request);

  if (unauthorized) {
    return unauthorized;
  }

  return Response.json(await dependencies.listRemoteSyncSnapshot());
}

export const Route = createFileRoute("/api/sync/snapshot")({
  server: {
    handlers: { GET: withHttpErrors(getSyncSnapshot) },
  },
});
