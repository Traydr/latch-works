import type { RemoteSnapshotResponseSchema } from "@latch-works/sync-protocol";
import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import { syncRoute } from "../server/sync/route";
import { listRemoteSyncSnapshot } from "../server/sync/store";

export const Route = createFileRoute("/api/sync/snapshot")({
  server: {
    handlers: {
      GET: syncRoute({
        parse: () => ({ ok: true, body: undefined }),
        handle: (): Promise<z.output<typeof RemoteSnapshotResponseSchema>> =>
          listRemoteSyncSnapshot(),
      }),
    },
  },
});
