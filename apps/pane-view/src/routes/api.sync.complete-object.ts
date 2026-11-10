import { createFileRoute } from "@tanstack/react-router";
import { syncRoute } from "../server/sync/route";
import { completeSyncedObject, markRemoteDeleted } from "../server/sync/store";
import { parseCompleteObjectBody } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/complete-object")({
  server: {
    handlers: {
      POST: syncRoute({
        parse: parseCompleteObjectBody,
        handle: (body) =>
          body.action === "delete" ? markRemoteDeleted(body) : completeSyncedObject(body),
      }),
    },
  },
});
