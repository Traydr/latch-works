import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { DoctorResult } from "../../../shared/types";
import { DoctorCheckList } from "../DoctorCheckList";
import { RunLogPanel } from "../RunLogPanel";
import type { RunProgressState } from "../../utils/runProgress";
import { progressPercent } from "../../utils/runProgress";
import { ProgressBar } from "./ProgressBar";
import { RunStageIndicator } from "./RunStageIndicator";

interface RunProgressPanelProps {
  compact?: boolean;
  defaultLogExpanded?: boolean;
  doctorResult: DoctorResult | null;
  logs: string[];
  onBack?: () => void;
  onCancel?: () => void;
  progress: RunProgressState;
  running: boolean;
  runLabel: string;
  showActions?: boolean;
}

export function RunProgressPanel({
  compact = false,
  defaultLogExpanded = false,
  doctorResult,
  logs,
  onBack,
  onCancel,
  progress,
  running,
  runLabel,
  showActions = true,
}: RunProgressPanelProps) {
  const [logExpanded, setLogExpanded] = useState(defaultLogExpanded || !running);
  const percent = progressPercent(progress);
  const displayLabel = progress.phaseLabel || runLabel || "Working…";

  return (
    <div className={`flex flex-col gap-3 ${compact ? "" : "prism-section"}`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className={`font-semibold tracking-tight ${compact ? "text-sm" : "text-base"}`}>
              {running ? "Sync in progress" : "Run activity"}
            </h3>
            <RunStageIndicator compact={compact} stage={progress.stage} />
          </div>
          <p
            className="truncate text-sm text-zinc-600 dark:text-zinc-300"
            title={displayLabel}
          >
            {displayLabel}
          </p>
          {progress.currentPath ? (
            <p
              className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400"
              title={progress.currentPath}
            >
              {progress.currentAction ? `${progress.currentAction} · ` : ""}
              {progress.currentPath}
            </p>
          ) : null}
        </div>
        {showActions ? (
          <div className="flex shrink-0 gap-2">
            {onCancel ? (
              <button className="prism-btn" disabled={!running} type="button" onClick={onCancel}>
                Cancel
              </button>
            ) : null}
            {onBack ? (
              <button className="prism-btn" type="button" onClick={onBack}>
                Back
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ProgressBar
        indeterminate={running && percent === null}
        percent={percent}
        size={compact ? "sm" : "md"}
        label={
          progress.stage === "transfer" && progress.total > 0
            ? `${progress.current} / ${progress.total} items`
            : progress.stage === "scanning"
              ? `${progress.filesFound.toLocaleString()} files found`
              : undefined
        }
      />

      {!compact ? <RunStageIndicator stage={progress.stage} /> : null}

      {doctorResult ? <DoctorCheckList result={doctorResult} /> : null}

      <div>
        <button
          className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs font-medium text-zinc-500 transition hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          type="button"
          onClick={() => setLogExpanded((current) => !current)}
        >
          {logExpanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          Activity log ({logs.length})
        </button>
        {logExpanded ? (
          <div className="mt-2">
            <RunLogPanel logs={logs} compact={compact} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
