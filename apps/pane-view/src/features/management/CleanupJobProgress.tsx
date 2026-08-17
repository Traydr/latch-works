import { Button } from "@/components/ui/button";
import type {
  LibraryWipeJobProgress,
  ShutterSourcePurgeJobProgress,
  SoftDeletedPurgeJobProgress,
} from "../../server/db/schema";
import type { CleanupJobStatus } from "../../server/management/cleanup-worker";

interface CleanupJobProgressProps {
  cancelError: string | null;
  isCancelling: boolean;
  job: CleanupJobStatus;
  onCancel: () => void;
}

const phaseLabels: Record<LibraryWipeJobProgress["phase"], string> = {
  completed: "Completed",
  db_hard_delete: "Removing database records",
  s3_originals: "Deleting originals",
  s3_orphan_sweep: "Sweeping storage orphans",
};

const purgePhaseLabels: Record<SoftDeletedPurgeJobProgress["phase"], string> = {
  completed: "Completed",
  db_hard_delete: "Removing database records",
  orphaned_media: "Deleting unreferenced originals",
};

const shutterPhaseLabels: Record<ShutterSourcePurgeJobProgress["phase"], string> = {
  completed: "Completed",
  queue_sources: "Finding deleted-item sources",
  shutter_sources: "Deleting Shutter sources",
};

export function CleanupJobProgress({
  cancelError,
  isCancelling,
  job,
  onCancel,
}: CleanupJobProgressProps) {
  const isActive = job.status === "pending" || job.status === "running";
  const isWipe = job.type === "library_hard_wipe";
  const isShutterPurge = job.type === "shutter_source_purge";
  const phaseLabel = isWipe
    ? phaseLabels[job.progress.phase]
    : isShutterPurge
      ? shutterPhaseLabels[job.progress.phase]
      : purgePhaseLabels[job.progress.phase];
  const jobTitle = isWipe
    ? "Library wipe cleanup"
    : isShutterPurge
      ? "Shutter source cleanup"
      : "Deleted-item cleanup";

  return (
    <section className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{jobTitle}</h3>
          <p className="text-xs text-muted-foreground">
            {isActive
              ? isShutterPurge
                ? "Shutter source cleanup is running in the background. Avoid starting a sync until this finishes."
                : "Storage and database cleanup is running in the background. Avoid starting a sync until this finishes."
              : job.status === "failed"
                ? "Cleanup failed. Review the error and retry the matching action below if needed."
                : job.status === "cancelled"
                  ? "Cleanup was cancelled. Work not yet processed remains queued."
                  : "Cleanup finished."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize">
            {job.status}
          </span>
          {isActive ? (
            <Button
              disabled={isCancelling}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              {isCancelling ? "Cancelling…" : "Cancel cleanup"}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{phaseLabel}</span>
          <span className="tabular-nums">{job.progress.processedCount} processed</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-amber-500 transition-[width]"
            style={{ width: `${estimateProgress(job)}%` }}
          />
        </div>
      </div>

      {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}
      {cancelError ? <p className="text-xs text-destructive">{cancelError}</p> : null}
    </section>
  );
}

function estimateProgress(job: CleanupJobStatus): number {
  if (job.type === "shutter_source_purge") {
    if (job.status === "completed") return 100;
    return { completed: 100, queue_sources: 25, shutter_sources: 60 }[job.progress.phase];
  }

  if (job.type === "soft_deleted_purge") {
    if (job.status === "completed") return 100;
    return { completed: 100, db_hard_delete: 85, orphaned_media: 35 }[job.progress.phase];
  }

  const phaseWeights: Record<LibraryWipeJobProgress["phase"], number> = {
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
