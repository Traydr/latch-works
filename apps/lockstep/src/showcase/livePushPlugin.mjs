import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../../..");

/** @type {{ events: object[], running: boolean, listeners: Set<(event: object) => void> }} */
const pushState = {
  events: [],
  running: false,
  listeners: new Set(),
};

function emit(event) {
  pushState.events.push(event);
  for (const listener of pushState.listeners) {
    listener(event);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function runLivePush(sourceRoot) {
  if (pushState.running) {
    return false;
  }

  pushState.running = true;
  pushState.events = [];

  try {
    const { pushChanges } = await import("@latch-works/lockstep-core");
    const apiUrl = process.env.LOCKSTEP_API_URL ?? "http://localhost:3000";
    const apiToken = process.env.LOCKSTEP_API_TOKEN ?? "local-sync-token-for-lockstep";

    emit({ type: "status", message: "Starting live push..." });

    await pushChanges(
      {
        apiToken,
        apiUrl,
        hashFiles: true,
        sourceRoot,
      },
      {
        onEvent: (event) => emit(event),
      },
    );

    return true;
  } catch (error) {
    emit({
      type: "status",
      message: error instanceof Error ? error.message : "Push failed",
    });
    emit({
      type: "complete",
      summary: {
        action: "push",
        completedAt: new Date().toISOString(),
        failed: 1,
        pushed: 0,
        status: "failed",
      },
    });
    return false;
  } finally {
    pushState.running = false;
    emit({ type: "demo-end" });
  }
}

export function showcaseLivePushPlugin() {
  return {
    name: "showcase-live-push",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";

        if (url === "/api/demo/push" && req.method === "POST") {
          let body = {};
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }

          const sourceRoot = body.sourceRoot ?? "/tmp/lockstep-demo-archive";
          void runLivePush(sourceRoot);

          res.statusCode = 202;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ started: true, sourceRoot }));
          return;
        }

        if (url === "/api/demo/push/stream" && req.method === "GET") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders?.();

          for (const event of pushState.events) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }

          const listener = (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (event.type === "demo-end") {
              pushState.listeners.delete(listener);
              res.end();
            }
          };

          pushState.listeners.add(listener);
          req.on("close", () => pushState.listeners.delete(listener));
          return;
        }

        next();
      });
    },
  };
}
