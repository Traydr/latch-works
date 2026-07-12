import type { CleanupJobStatus } from "../../server/management/cleanup-worker";

interface CleanupJobProgressProps {
  job: CleanupJobStatus;
}

const phaseLabels: Record<CleanupJobStatus["progress"]["phase"], string> = {
  completed: "Completed",
  db_hard_delete: "Removing database records",
  s3_originals: "Deleting originals",
  s3_orphan_sweep: "Sweeping storage orphans",
};

export function CleanupJobProgress({ job }: CleanupJobProgressProps) {
  const isActive = job.status === "pending" || job.status === "running";

  return (
    <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Library wipe cleanup</h3>
          <p className="text-xs text-muted-foreground">
            {isActive
              ? "Storage and database cleanup is running in the background. Avoid starting a sync until this finishes."
              : job.status === "failed"
                ? "Cleanup failed. Review the error and retry from the danger zone if needed."
                : "Cleanup finished."}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize">
          {job.status}
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{phaseLabels[job.progress.phase]}</span>
          <span className="tabular-nums">{job.progress.processedCount} processed</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-amber-500 transition-[width]"
            style={{ width: `${estimateProgress(job)}%` }}
          />
        </div>
      </div>

      {job.progress.errorCount > 0 ? (
        <p className="tabular-nums text-xs text-destructive">
          {job.progress.errorCount} storage delete error
          {job.progress.errorCount === 1 ? "" : "s"} (best-effort cleanup continues).
        </p>
      ) : null}

      {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
    </section>
  );
}

function estimateProgress(job: CleanupJobStatus): number {
  const phaseWeights: Record<CleanupJobStatus["progress"]["phase"], number> = {
    completed: 100,
    db_hard_delete: 90,
    s3_originals: 40,
    s3_orphan_sweep: 75,
  };

  if (job.status === "completed") {
    return 100;
  }

  return phaseWeights[job.progress.phase] ?? 10;
}
