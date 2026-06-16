import { serve } from "@hono/node-server";
import { resolveMediaOptimizerPort } from "./env.js";
import { createServer } from "./server.js";

const app = createServer();

serve({ fetch: app.fetch, port: resolveMediaOptimizerPort() }, (info) => {
  console.info(
    JSON.stringify({
      event: "media-optimizer.listening",
      port: info.port,
      ts: new Date().toISOString(),
    }),
  );
});
