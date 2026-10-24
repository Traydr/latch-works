import type { Job } from "@latch-works/glazier-core/contract";
import { Pause, Play } from "lucide-react";
import { ProgressBar } from "../../../../../ui/ui";
import { call } from "../../lib/api";
import { useEngine } from "../../lib/engine-state";
import { formatCount } from "../../lib/format";

/** "15 of 35", or what the job is doing before it has a count. */
export function jobCount(job: Job | null): string {
  if (job?.state === "paused") {
    return "Paused";
  }

  return job && job.total > 0
    ? `${formatCount(job.done)} of ${formatCount(job.total)}`
    : "Starting";
}

/**
 * The progress of work a view started, shown in place of its primary button: a bar, the count,
 * and Pause (when `pausable`) and Stop.
 */
export function RunProgress({
  job,
  label,
  width = 160,
  pausable = true,
}: {
  job: Job | null;
  /** The text beside the bar; the count by default. */
  label?: string;
  width?: number;
  pausable?: boolean;
}) {
  const { report } = useEngine();
  const paused = job?.state === "paused";

  return (
    <div className="flex h-9 items-center gap-3" data-running>
      <div className="shrink-0" style={{ width }}>
        <ProgressBar ratio={job && job.total > 0 ? job.done / job.total : null} />
      </div>
      <span className="text-[13px] whitespace-nowrap text-zinc-500 dark:text-zinc-400">
        {label ?? jobCount(job)}
      </span>
      <div className="flex items-center gap-1.5">
        {pausable ? (
          <button
            type="button"
            className="lw-btn lw-btn-ghost lw-btn-icon-sm"
            aria-label={paused ? "Resume" : "Pause"}
            title={paused ? "Resume" : "Pause"}
            disabled={!job}
            onClick={() =>
              job && void call("pauseJob", { jobId: job.id, paused: !paused }).catch(report)
            }
          >
            {paused ? <Play /> : <Pause />}
          </button>
        ) : null}
        <button
          type="button"
          className="lw-btn lw-btn-secondary lw-btn-sm"
          title="Finished steps stay done"
          disabled={!job}
          onClick={() => job && void call("cancelJob", { jobId: job.id }).catch(report)}
        >
          Stop
        </button>
      </div>
    </div>
  );
}
