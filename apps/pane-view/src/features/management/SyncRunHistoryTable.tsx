import { Button } from "@/components/ui/button";
import type { SyncRunHistoryEntry } from "./management-contract";

interface SyncRunHistoryTableProps {
  cancellingSyncRunId?: string | null;
  isCancellingAll?: boolean;
  onCancelAllRunning?: () => void;
  onCancelRun?: (syncRunId: string) => void;
  runs: SyncRunHistoryEntry[];
}

export function SyncRunHistoryTable({
  cancellingSyncRunId = null,
  isCancellingAll = false,
  onCancelAllRunning,
  onCancelRun,
  runs,
}: SyncRunHistoryTableProps) {
  const runningCount = runs.filter((run) => run.status === "running").length;

  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No sync runs recorded yet.</p>;
  }

  return (
    <div className="space-y-3">
      {runningCount > 0 && onCancelAllRunning ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="text-sm text-muted-foreground">
            {runningCount} sync run{runningCount === 1 ? "" : "s"} marked running. Stop stuck runs
            to unlock maintenance actions.
          </p>
          <Button
            disabled={isCancellingAll}
            onClick={onCancelAllRunning}
            size="sm"
            type="button"
            variant="outline"
          >
            Stop all running
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl bg-card shadow-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Started</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Counts</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr className="border-b border-border/70 last:border-b-0" key={run.id}>
                <td className="px-3 py-2 align-top">{formatTimestamp(run.startedAt)}</td>
                <td className="px-3 py-2 align-top">
                  <StatusBadge status={run.status} />
                  {run.error ? <p className="mt-1 text-xs text-destructive">{run.error}</p> : null}
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs">{run.sourceRoot}</td>
                <td className="px-3 py-2 align-top font-mono text-xs">
                  {formatCounts(run.counts)}
                </td>
                <td className="px-3 py-2 align-top">
                  {run.status === "running" && onCancelRun ? (
                    <Button
                      disabled={isCancellingAll || cancellingSyncRunId === run.id}
                      onClick={() => onCancelRun(run.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Stop
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: SyncRunHistoryEntry["status"] }) {
  const className =
    status === "completed"
      ? "text-success"
      : status === "running"
        ? "text-warning"
        : status === "failed"
          ? "text-destructive"
          : "text-muted-foreground";

  return <span className={className}>{status}</span>;
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}
