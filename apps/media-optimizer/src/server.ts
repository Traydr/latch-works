import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { env } from "./env.js";
import { processBatch } from "./processor.js";

// Single-flight guard: enforce concurrency 1 across overlapping /process calls.
let inFlight: Promise<void> | null = null;

function startProcessing(): void {
  inFlight = processBatch()
    .then((result) => {
      console.log(JSON.stringify({ event: "media-optimizer.process", ...result }));
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : "process failed",
          event: "media-optimizer.process_failed",
        }),
      );
    })
    .finally(() => {
      inFlight = null;
    });
}

export function createServer(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "media-optimizer" }));

  const internal = new Hono();
  internal.use("*", bearerAuth({ token: env.MEDIA_OPTIMIZER_TOKEN }));

  internal.post("/optimizer/process", async (c) => {
    if (inFlight) {
      return c.json({ status: "busy" }, 202);
    }

    startProcessing();
    return c.json({ status: "started" }, 202);
  });

  app.route("/internal", internal);

  return app;
}
