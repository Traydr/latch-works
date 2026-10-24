import { type ChildProcess, spawn } from "node:child_process";

export interface ToolRun {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

/** Every ffmpeg and ffprobe still running, so shutdown can stop them instead of orphaning them. */
const runningTools = new Set<ChildProcess>();

/**
 * Kills every tool this process started that is still running. The engine calls it as it shuts
 * down: a child process outlives its killed parent, and a long ffmpeg would keep running.
 */
export function killRunningTools(): void {
  for (const child of runningTools) {
    child.kill("SIGKILL");
  }

  runningTools.clear();
}

/** Most ffmpeg output Glazier reads is a 1 KiB frame or a JSON probe; 64 MiB bounds a runaway. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs ffmpeg or ffprobe and collects its output. Never rejects for a non-zero exit; callers read
 * `code`. Rejects when the process cannot start or the signal aborts it.
 */
export function runTool(run: ToolRun): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(abortError());

      return;
    }

    const child = spawn(run.executable, [...run.args], { windowsHide: true });
    runningTools.add(child);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, run.timeoutMs);

    const abort = () => child.kill("SIGKILL");

    run.signal?.addEventListener("abort", abort, { once: true });

    const finish = () => {
      settled = true;
      runningTools.delete(child);
      clearTimeout(timeout);
      run.signal?.removeEventListener("abort", abort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");

        return;
      }

      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // ffmpeg's interesting lines are at the end; keep the last 64 KiB.
      stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      finish();
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      finish();

      if (run.signal?.aborted) {
        reject(abortError());

        return;
      }

      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut });
    });
  });
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}
