import { CheckCircle2, Hash, LoaderCircle, ScanSearch, Upload } from "lucide-react";

import type { RunProgressStage } from "../../utils/runProgress";

interface RunStageIndicatorProps {
  compact?: boolean;
  stage: RunProgressStage;
}

const stages: Array<{ key: RunProgressStage; label: string; icon: typeof ScanSearch }> = [
  { key: "scanning", label: "Scan", icon: ScanSearch },
  { key: "hashing", label: "Hash", icon: Hash },
  { key: "transfer", label: "Transfer", icon: Upload },
  { key: "complete", label: "Done", icon: CheckCircle2 },
];

function stageIndex(stage: RunProgressStage): number {
  if (stage === "idle") {
    return -1;
  }
  if (stage === "scanning") {
    return 0;
  }
  if (stage === "hashing") {
    return 1;
  }
  if (stage === "transfer") {
    return 2;
  }
  return 3;
}

export function RunStageIndicator({ compact = false, stage }: RunStageIndicatorProps) {
  const activeIndex = stageIndex(stage);

  if (compact) {
    const active = stages.find((entry) => entry.key === stage) ?? stages[0];
    const Icon = active.icon;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        {stage !== "complete" && stage !== "idle" ? (
          <LoaderCircle className="size-3 animate-spin text-violet-500" aria-hidden />
        ) : (
          <Icon className="size-3" aria-hidden />
        )}
        {active.label}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {stages.map((entry, index) => {
        const Icon = entry.icon;
        const isActive = index === activeIndex;
        const isComplete = activeIndex > index;

        return (
          <div key={entry.key} className="flex items-center gap-1">
            <div
              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium ${
                isActive
                  ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200"
                  : isComplete
                    ? "text-zinc-500 dark:text-zinc-400"
                    : "text-zinc-400 dark:text-zinc-600"
              }`}
            >
              {isActive && stage !== "complete" ? (
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
              ) : (
                <Icon className="size-3" aria-hidden />
              )}
              {entry.label}
            </div>
            {index < stages.length - 1 ? (
              <div
                className={`h-px w-4 ${isComplete ? "bg-violet-400/60" : "bg-zinc-300 dark:bg-zinc-700"}`}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
