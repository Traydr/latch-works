import { formatBytes } from "@latch-works/media-domain";
import type { CleanupJobStatus } from "../../server/management/cleanup-worker";

export function LegacyDerivativeCleanupProgress({
  job,
  totalCount,
}: {
  job: CleanupJobStatus;
  totalCount?: number;
}) {
  if (job.type !== "legacy_derivative_cleanup") return null;
  const active = job.status === "pending" || job.status === "running";
  const percent =
    totalCount && totalCount > 0
      ? Math.min(100, Math.round((job.progress.processedCount / totalCount) * 100))
      : job.status === "completed"
        ? 100
        : 8;

  return (
    <div className="space-y-3 rounded-lg bg-amber-500/5 p-3 ring-1 ring-inset ring-amber-500/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Legacy derivative cleanup</p>
          <p className="text-xs text-muted-foreground">
            {active
              ? `Deleting objects under ${job.progress.prefix}`
              : job.status === "completed"
                ? "Legacy derivative storage is empty."
                : "Cleanup stopped before all objects could be removed."}
          </p>
        </div>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs capitalize ring-1 ring-inset ring-border">
          {job.status}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-amber-500 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{job.progress.processedCount.toLocaleString()} deleted</span>
        <span className="tabular-nums">{formatBytes(job.progress.processedBytes)} reclaimed</span>
        {job.progress.errorCount > 0 ? (
          <span className="tabular-nums text-destructive">
            {job.progress.errorCount.toLocaleString()} errors
          </span>
        ) : null}
      </div>
      {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
    </div>
  );
}
