import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SyncRunNotFoundError } from "../server/sync/errors";
import { syncRoute } from "../server/sync/route";
import { finalizeSyncRun } from "../server/sync/sync-runs";
import { parseFinalizeSyncRunBody } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/runs/$syncRunId/complete")({
  server: {
    handlers: {
      POST: syncRoute({
        parse: parseFinalizeSyncRunBody,
        handle: (outcome, { syncRunId }: { syncRunId: string }) => {
          if (!z.uuid().safeParse(syncRunId).success) {
            throw new SyncRunNotFoundError();
          }

          return finalizeSyncRun(syncRunId, outcome);
        },
      }),
    },
  },
});
