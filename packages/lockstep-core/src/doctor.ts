import { stat } from "node:fs/promises";
import { fetchRemoteSnapshot } from "./remote-snapshot.js";
import type { DoctorOptions, DoctorResult, LockstepObserver } from "./types.js";

export async function doctor(
  options: DoctorOptions,
  observer?: LockstepObserver,
): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = [];

  if (options.sourceRoot) {
    try {
      const sourceStat = await stat(options.sourceRoot);
      const isDirectory = sourceStat.isDirectory();
      checks.push({
        detail: options.sourceRoot,
        label: "Source path",
        ok: isDirectory,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        detail: `${options.sourceRoot} (${message})`,
        label: "Source path",
        ok: false,
      });
    }
  }

  if (options.apiUrl) {
    checks.push({
      detail: options.apiUrl,
      label: "API URL",
      ok: true,
    });
  } else {
    checks.push({
      label: "API URL",
      ok: false,
    });
  }

  if (options.apiToken) {
    checks.push({
      label: "API token",
      ok: true,
    });
  } else {
    checks.push({
      label: "API token",
      ok: false,
    });
  }

  if (options.apiUrl && options.apiToken) {
    observer?.onEvent({ type: "status", message: "Checking API snapshot endpoint..." });
    try {
      const entries = await fetchRemoteSnapshot(options.apiUrl, options.apiToken, options.signal);
      checks.push({
        detail: `${entries.length} remote entries`,
        label: "API snapshot",
        ok: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({
        detail: message,
        label: "API snapshot",
        ok: false,
      });
    }
  }

  const result: DoctorResult = {
    checks,
    ok: checks.every((check) => check.ok),
  };

  observer?.onEvent({
    type: "complete",
    summary: {
      action: "doctor",
      completedAt: new Date().toISOString(),
      failed: result.ok ? 0 : 1,
      message: result.ok ? "All checks passed." : "Some checks failed.",
      pushed: 0,
      status: result.ok ? "completed" : "failed",
    },
  });

  return result;
}
