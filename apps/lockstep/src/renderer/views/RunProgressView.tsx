import { Activity, LoaderCircle } from "lucide-react";

import type { DoctorResult } from "../../shared/types";
import { DoctorCheckList } from "../components/DoctorCheckList";
import { RunLogPanel } from "../components/RunLogPanel";

interface RunProgressViewProps {
  doctorResult: DoctorResult | null;
  logs: string[];
  onBack: () => void;
  onCancel: () => void;
  running: boolean;
  runLabel: string;
}

export function RunProgressView({
  doctorResult,
  logs,
  onBack,
  onCancel,
  running,
  runLabel,
}: RunProgressViewProps) {
  return (
    <section className="prism-section">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {running ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-violet-600 dark:text-violet-300"
              aria-hidden
            />
          ) : (
            <Activity className="size-4 shrink-0 text-zinc-500" aria-hidden />
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">Run progress</h2>
            <p
              className="truncate text-sm text-zinc-500 dark:text-zinc-400"
              title={runLabel || "Working..."}
            >
              {runLabel || "Working..."}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="prism-btn" disabled={!running} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="prism-btn" type="button" onClick={onBack}>
            Back to dashboard
          </button>
        </div>
      </div>

      {doctorResult ? (
        <div className="mb-4">
          <DoctorCheckList result={doctorResult} />
        </div>
      ) : null}

      <RunLogPanel logs={logs} />
    </section>
  );
}
