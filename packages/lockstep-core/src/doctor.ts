import { stat } from "node:fs/promises";
import { toError } from "./errors.js";
import { fetchRemoteSnapshot } from "./remote-snapshot.js";
import type { DoctorCheck, DoctorOptions, DoctorResult, LockstepObserver } from "./types.js";

export async function doctor(
  options: DoctorOptions,
  observer?: LockstepObserver,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  if (options.sourceRoot) {
    try {
      const sourceStat = await stat(options.sourceRoot);
      checks.push({
        detail: options.sourceRoot,
        label: "Source path",
        ok: sourceStat.isDirectory(),
      });
    } catch (error) {
      checks.push({
        detail: `${options.sourceRoot} (${toError(error).message})`,
        label: "Source path",
        ok: false,
      });
    }
  }

  checks.push(
    options.apiUrl
      ? { detail: options.apiUrl, label: "API URL", ok: true }
      : { label: "API URL", ok: false },
  );
  checks.push({ label: "API token", ok: Boolean(options.apiToken) });

  if (options.apiUrl && options.apiToken) {
    observer?.onEvent({ type: "status", message: "Checking API snapshot endpoint..." });

    try {
      const entries = await fetchRemoteSnapshot(
        { apiToken: options.apiToken, apiUrl: options.apiUrl },
        options.signal,
      );

      checks.push({ detail: `${entries.length} remote entries`, label: "API snapshot", ok: true });
    } catch (error) {
      checks.push({ detail: toError(error).message, label: "API snapshot", ok: false });
    }
  }

  const ok = checks.every((check) => check.ok);

  return {
    checks,
    ok,
    summary: {
      action: "doctor",
      applied: 0,
      failed: ok ? 0 : 1,
      message: ok ? "All checks passed." : "Some checks failed.",
      skipped: 0,
      status: ok ? "completed" : "failed",
    },
  };
}
