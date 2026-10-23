import type { Job } from "@latch-works/glazier-core/contract";
import { Pause, Play, X } from "lucide-react";
import { useState } from "react";

import { call } from "../lib/api";
import { useEngine } from "../lib/engine-state";
import { formatCount } from "../lib/format";
import { ProgressBar } from "./ui";

function isActive(job: Job): boolean {
  return job.state === "queued" || job.state === "running" || job.state === "paused";
}

/** The queue at the bottom of the window: what is running, what waits, and what just failed. */
export function JobBar() {
  const { jobs, report } = useEngine();
  const active = jobs.filter(isActive).reverse();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failed = jobs.find((job) => job.state === "failed");

  if (active.length === 0 && (!failed || failed.id === dismissed)) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-t ls-divider bg-zinc-50 px-4 py-2 dark:bg-zinc-900/60"
      data-testid="job-bar"
    >
      {active.map((job) => (
        <div
          key={job.id}
          className="flex items-center gap-3 py-0.5 text-xs"
          data-job-type={job.type}
          data-job-state={job.state}
        >
          <span className="w-56 shrink-0 truncate font-medium">{job.label}</span>
          <span className="w-56 shrink-0 truncate text-zinc-500">
            {job.state === "queued"
              ? "Waiting"
              : job.state === "paused"
                ? "Paused"
                : (job.message ?? "Working")}
          </span>
          <div className="min-w-0 flex-1">
            <ProgressBar
              ratio={job.state === "queued" ? 0 : job.total > 0 ? job.done / job.total : null}
            />
          </div>
          <span className="tabular w-28 shrink-0 text-right text-zinc-500">
            {job.total > 0
              ? `${formatCount(job.done)} / ${formatCount(job.total)}`
              : job.done > 0
                ? formatCount(job.done)
                : ""}
          </span>
          {job.state === "running" || job.state === "paused" ? (
            <button
              type="button"
              className="ls-btn ls-btn-ghost px-1.5"
              aria-label={job.state === "paused" ? "Resume" : "Pause"}
              onClick={() =>
                void call("pauseJob", { jobId: job.id, paused: job.state === "running" }).catch(
                  report,
                )
              }
            >
              {job.state === "paused" ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="ls-btn ls-btn-ghost px-1.5"
            aria-label="Cancel"
            onClick={() => void call("cancelJob", { jobId: job.id }).catch(report)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {failed && failed.id !== dismissed && active.length === 0 ? (
        <div className="flex items-center gap-3 text-xs text-red-700 dark:text-red-300">
          <span className="font-medium">{failed.label} failed</span>
          <span className="min-w-0 flex-1 truncate">{failed.message}</span>
          <button
            type="button"
            className="ls-btn ls-btn-ghost px-1.5"
            aria-label="Dismiss"
            onClick={() => setDismissed(failed.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
