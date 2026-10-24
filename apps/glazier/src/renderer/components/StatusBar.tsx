import type { Job } from "@latch-works/glazier-core/contract";
import { Pause, Play, X } from "lucide-react";
import { useState } from "react";

import { call } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { formatBytes, formatCount, formatRelative, plural } from "../lib/format";
import { useNow } from "../lib/hotkeys";
import { Kbd, Spinner } from "./ui";

function isActive(job: Job): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}

/**
 * Lockstep's status line: idle and when the root was last scanned, or the job that is running
 * with its progress, Pause and Stop. Background analysis shows the same way, in grey.
 */
export function StatusBar({ onShortcuts }: { onShortcuts: () => void }) {
  const { jobs, roots, rootId, report } = useEngine();
  const root = roots.find((candidate) => candidate.id === rootId) ?? null;
  const active = jobs.filter(isActive);

  const current =
    active.find((job) => job.state === "running" || job.state === "paused") ?? active[0] ?? null;

  const queued = active.length - (current ? 1 : 0);
  const now = useNow(current === null);

  // A failed scan or analysis stays until it is dismissed or the same job succeeds again; failed
  // plans report through their toast instead.
  const failed = jobs.find(
    (job) =>
      job.state === "failed" &&
      job.type !== "apply" &&
      job.type !== "undo" &&
      jobs.find((other) => other.type === job.type && other.rootId === job.rootId) === job,
  );

  const [dismissedFailure, setDismissedFailure] = useState<string | null>(null);
  const ratio = current && current.total > 0 ? current.done / current.total : null;

  return (
    <footer
      className="relative flex h-[26px] shrink-0 items-center gap-3 border-t ls-divider bg-zinc-50 px-3 ls-mono text-[10.5px] dark:bg-zinc-900/60"
      data-testid="status-bar"
      data-job-type={current?.type}
      data-job-state={current?.state}
    >
      {current && ratio !== null ? (
        <span
          className={`absolute -top-px left-0 h-[2px] transition-[width] duration-300 ${
            current.background ? "bg-zinc-400/70" : "bg-violet-500"
          }`}
          style={{ width: `${Math.round(ratio * 100)}%` }}
          aria-hidden
        />
      ) : null}

      {current ? (
        <>
          <span
            className={`inline-flex min-w-0 shrink items-center gap-1.5 ${
              current.background ? "text-zinc-500" : "text-violet-700 dark:text-violet-300"
            }`}
          >
            {current.state === "paused" ? <Pause className="size-2.5" aria-hidden /> : <Spinner />}
            <span className="truncate">{current.label}</span>
            {current.total > 0 ? (
              <span className="tabular">
                {formatCount(current.done)}/{formatCount(current.total)}
              </span>
            ) : null}
          </span>
          {current.state === "paused" ? (
            <span className="text-zinc-500">paused</span>
          ) : current.message && current.message !== current.label ? (
            <span className="min-w-0 truncate text-zinc-500">{current.message}</span>
          ) : null}
          <span className="flex shrink-0 items-center">
            {current.state === "running" || current.state === "paused" ? (
              <button
                type="button"
                className="ls-btn ls-btn-ghost px-1 py-0"
                aria-label={current.state === "paused" ? "Resume" : "Pause"}
                title={current.state === "paused" ? "Resume" : "Pause"}
                onClick={() =>
                  void call("pauseJob", {
                    jobId: current.id,
                    paused: current.state === "running",
                  }).catch(report)
                }
              >
                {current.state === "paused" ? (
                  <Play className="size-3" />
                ) : (
                  <Pause className="size-3" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              className="ls-btn ls-btn-ghost px-1 py-0"
              aria-label="Stop"
              title="Stop (finished steps stay done and can be undone)"
              onClick={() => void call("cancelJob", { jobId: current.id }).catch(report)}
            >
              <X className="size-3" />
            </button>
          </span>
          {queued > 0 ? <span className="shrink-0 text-zinc-500">+{queued} queued</span> : null}
        </>
      ) : failed && failed.id !== dismissedFailure ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 text-red-700 dark:text-red-300">
          <span className="size-1.5 shrink-0 rounded-full bg-red-500" aria-hidden />
          <span className="truncate">
            {failed.label} failed: {failed.message}
          </span>
          <button
            type="button"
            className="ls-btn ls-btn-ghost px-1 py-0"
            aria-label="Dismiss"
            onClick={() => setDismissedFailure(failed.id)}
          >
            <X className="size-3" />
          </button>
        </span>
      ) : (
        <>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            idle
          </span>
          {root ? (
            <span className="truncate text-zinc-500">
              scanned {formatRelative(root.lastScanAt, now)}
            </span>
          ) : null}
        </>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-3 text-zinc-500">
        {root ? (
          <span className="tabular">
            {plural(root.fileCount, "file")} · {formatBytes(root.totalBytes)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onShortcuts}
          className="inline-flex items-center gap-1.5 rounded px-1 hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          Shortcuts <Kbd>?</Kbd>
        </button>
      </span>
    </footer>
  );
}
