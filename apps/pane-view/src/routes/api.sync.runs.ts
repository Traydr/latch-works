import type { SyncRunSchema } from "@latch-works/sync-protocol";
import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import { syncRoute } from "../server/sync/route";
import { startSyncRun } from "../server/sync/sync-runs";
import { parseCreateSyncRunBody } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/runs")({
  server: {
    handlers: {
      POST: syncRoute({
        parse: parseCreateSyncRunBody,
        handle: (input): Promise<z.input<typeof SyncRunSchema>> => startSyncRun(input),
      }),
    },
  },
});
