import { env } from "../../env/server";
import { logDerivativeEvent } from "./derivative-telemetry";

const WAKE_COOLDOWN_MS = 5_000;
const WAKE_TIMEOUT_MS = 4_000;

let lastWakeAt = 0;
let wakeInFlight = false;

/**
 * Best-effort nudge to the media-optimizer's /process endpoint. Fire-and-forget
 * with a short timeout and a cooldown so high-frequency client polls cannot
 * stampede the optimizer. Never throws; wake failures are logged and ignored.
 */
export async function wakeOptimizer(reason: string): Promise<void> {
  if (!env.MEDIA_OPTIMIZER_URL || !env.MEDIA_OPTIMIZER_TOKEN) {
    logDerivativeEvent("optimizer.wake_skipped", {
      configured: false,
      reason,
    });
    return;
  }

  const now = Date.now();
  if (wakeInFlight || now - lastWakeAt < WAKE_COOLDOWN_MS) {
    logDerivativeEvent("optimizer.wake_skipped", {
      cooldownMsRemaining: Math.max(0, WAKE_COOLDOWN_MS - (now - lastWakeAt)),
      inFlight: wakeInFlight,
      reason,
    });
    return;
  }

  wakeInFlight = true;
  lastWakeAt = now;
  logDerivativeEvent("optimizer.wake_requested", { reason });

  try {
    const response = await fetch(new URL("/internal/optimizer/process", env.MEDIA_OPTIMIZER_URL), {
      body: "{}",
      headers: {
        authorization: `Bearer ${env.MEDIA_OPTIMIZER_TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });

    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    logDerivativeEvent("optimizer.wake_result", {
      ok: response.ok,
      reason,
      runId: typeof body?.runId === "string" ? body.runId : undefined,
      status: response.status,
      wakeStatus: typeof body?.status === "string" ? body.status : undefined,
    });
  } catch (error) {
    // Timeouts are expected: the optimizer keeps processing after we stop waiting.
    logDerivativeEvent("optimizer.wake_failed", {
      detail: error instanceof Error ? error.name : "unknown",
      reason,
    });
  } finally {
    wakeInFlight = false;
  }
}
