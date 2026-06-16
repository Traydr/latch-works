import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { env } from "./env.js";
import { logOptimizerError, logOptimizerEvent, sanitizeError } from "./logging.js";
import { type ProcessResult, processBatch } from "./processor.js";

// Single-flight guard: enforce concurrency 1 across overlapping /process calls.
let inFlight: Promise<void> | null = null;
let currentRunId: string | undefined;

export interface OptimizerRunStatus extends ProcessResult {
  finishedAt: string;
  runId: string;
  startedAt: string;
}

let lastRun: OptimizerRunStatus | undefined;

function startProcessing(runId: string): void {
  const startedAt = new Date().toISOString();
  currentRunId = runId;
  inFlight = processBatch(runId)
    .then((result) => {
      lastRun = {
        ...result,
        finishedAt: new Date().toISOString(),
        runId,
        startedAt,
      };
    })
    .catch((error) => {
      logOptimizerError("optimizer.process_failed", {
        error: sanitizeError(error),
        runId,
      });
    })
    .finally(() => {
      inFlight = null;
      currentRunId = undefined;
    });
}

export function createServer(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "media-optimizer" }));

  const internal = new Hono();
  internal.use("*", bearerAuth({ token: env.MEDIA_OPTIMIZER_TOKEN }));

  internal.post("/optimizer/process", async (c) => {
    const runId = randomUUID();
    if (inFlight) {
      logOptimizerEvent("optimizer.process_requested", {
        currentRunId,
        requestedRunId: runId,
        status: "busy",
        userAgent: c.req.header("user-agent"),
      });
      return c.json({ currentRunId, status: "busy" }, 202);
    }

    logOptimizerEvent("optimizer.process_requested", {
      runId,
      status: "started",
      userAgent: c.req.header("user-agent"),
    });
    startProcessing(runId);
    return c.json({ runId, status: "started" }, 202);
  });

  internal.get("/optimizer/status", (c) => {
    return c.json({
      currentRunId,
      inFlight: Boolean(inFlight),
      lastRun,
      service: "media-optimizer",
    });
  });

  app.route("/internal", internal);

  return app;
}
