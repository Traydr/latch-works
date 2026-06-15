import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { env } from "./env.js";
import { type ProcessResult, processBatch } from "./processor.js";

// Single-flight guard: enforce concurrency 1 across overlapping /process calls.
let inFlight: Promise<ProcessResult> | null = null;

export function createServer(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "media-optimizer" }));

  const internal = new Hono();
  internal.use("*", bearerAuth({ token: env.MEDIA_OPTIMIZER_TOKEN }));

  internal.post("/optimizer/process", async (c) => {
    if (inFlight) {
      return c.json({ status: "busy" }, 409);
    }

    inFlight = processBatch();
    try {
      const result = await inFlight;
      return c.json({ status: "ok", ...result });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "process failed", status: "error" },
        500,
      );
    } finally {
      inFlight = null;
    }
  });

  app.route("/internal", internal);

  return app;
}
