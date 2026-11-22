import { createFileRoute } from "@tanstack/react-router";
import { syncRoute } from "../server/sync/route";
import { recordMediaFacts } from "../server/sync/store";
import { parseReportMediaFactsBody } from "../server/sync/validation";

export const Route = createFileRoute("/api/sync/media-facts")({
  server: {
    handlers: {
      POST: syncRoute({
        parse: parseReportMediaFactsBody,
        handle: (facts) => recordMediaFacts(facts),
      }),
    },
  },
});
