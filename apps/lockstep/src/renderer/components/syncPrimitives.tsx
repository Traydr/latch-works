import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { RunPhase, RunProgressState } from "../hooks/useLockstepController";

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const value = bytes;
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

const PHASE_STEPS = ["scan", "plan", "push", "done"] as const;

export function phaseStepIndex(phase: RunPhase, action: string): number {
  if (phase === "idle") return -1;
  if (phase === "done" || phase === "cancelled" || phase === "error") return 3;
  if (phase === "planning") return 1;
  if (phase === "scanning" || phase === "hashing") return 0;
  if (phase === "items") {
    return action === "plan" ? 1 : action === "doctor" ? 1 : 2;
  }
  return -1;
}

export function deriveRunPercent(progress: RunProgressState): number | null {
  if (progress.phase === "items" && progress.itemTotal > 0) {
    return Math.min(1, progress.itemCurrent / progress.itemTotal);
  }
  if (progress.phase === "done") {
    return 1;
  }
  if (
    progress.phase === "planning" ||
    progress.phase === "scanning" ||
    progress.phase === "hashing"
  ) {
    return null;
  }
  return null;
}

const ACTION_COLORS: Record<string, string> = {
  upload: "text-sky-400",
  update: "text-amber-400",
  delete: "text-red-400",
  keep: "text-zinc-500",
};

const ACTION_BG: Record<string, string> = {
  upload: "bg-sky-500",
  update: "bg-amber-500",
  delete: "bg-red-500",
  keep: "bg-zinc-600",
};

const ACTION_CHIP: Record<string, string> = {
  upload: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  update: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  delete: "border-red-500/40 bg-red-500/10 text-red-300",
  keep: "border-zinc-600/50 bg-zinc-700/30 text-zinc-400",
};

export function ActionChip({ action, className = "" }: { action: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${ACTION_CHIP[action] ?? ACTION_CHIP.keep} ${className}`}
    >
      {action}
    </span>
  );
}

export function ProgressBar({
  percent,
  indeterminate = false,
  tone = "violet",
  className = "",
}: {
  percent: number | null;
  indeterminate?: boolean;
  tone?: "violet" | "emerald" | "red";
  className?: string;
}) {
  const toneClass =
    tone === "emerald" ? "bg-emerald-500" : tone === "red" ? "bg-red-500" : "bg-violet-500";
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent * 100));
  return (
    <div
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-800 dark:bg-zinc-800 ${className}`}
    >
      {indeterminate ? (
        <div
          className={`absolute inset-y-0 w-1/3 animate-[ls-indeterminate_1.1s_ease-in-out_infinite] rounded-full ${toneClass}`}
        />
      ) : (
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out ${toneClass}`}
          style={{ width: `${width}%` }}
        />
      )}
    </div>
  );
}

const SEGMENT_ORDER = ["upload", "update", "delete", "keep"] as const;

export function ProportionBar({
  counts,
  className = "",
}: {
  counts: { upload: number; update: number; delete: number; keep: number };
  className?: string;
}) {
  const total = SEGMENT_ORDER.reduce((sum, key) => sum + counts[key], 0);
  if (total === 0) {
    return <div className={`h-2 w-full rounded-full bg-zinc-800 ${className}`} />;
  }
  return (
    <div className={`flex h-2 w-full overflow-hidden rounded-full bg-zinc-800 ${className}`}>
      {SEGMENT_ORDER.map((key) => {
        const value = counts[key];
        if (value === 0) {
          return null;
        }
        return (
          <div
            key={key}
            className={ACTION_BG[key]}
            style={{ width: `${(value / total) * 100}%` }}
            title={`${key}: ${value}`}
          />
        );
      })}
    </div>
  );
}

export function PhaseSteps({
  phase,
  action,
  className = "",
}: {
  phase: RunPhase;
  action: string;
  className?: string;
}) {
  const currentIndex = phaseStepIndex(phase, action);
  const labels = action === "prune" ? ["scan", "plan", "prune", "done"] : PHASE_STEPS;
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {labels.map((label, index) => {
        const isDone = currentIndex > index || phase === "done";
        const isCurrent = currentIndex === index && phase !== "done" && phase !== "idle";
        return (
          <div key={label} className="flex flex-1 items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <span
                className={`flex size-4 items-center justify-center rounded-full border text-[9px] ${
                  isDone
                    ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                    : isCurrent
                      ? "border-violet-400 bg-violet-500/30 text-violet-200"
                      : "border-zinc-700 bg-zinc-800/60 text-zinc-600"
                }`}
              >
                {isDone ? "✓" : index + 1}
              </span>
              <span
                className={`font-mono text-[10px] uppercase tracking-wide ${
                  isDone || isCurrent ? "text-zinc-300" : "text-zinc-600"
                }`}
              >
                {label}
              </span>
            </div>
            {index < labels.length - 1 ? (
              <div
                className={`h-px flex-1 ${isDone ? "bg-emerald-500/40" : "bg-zinc-800"}`}
                aria-hidden
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
  className = "",
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="font-mono text-[10px] tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className={`mt-0.5 truncate font-mono text-sm tabular-nums ${tone ?? "text-zinc-200"}`}>
        {value}
      </p>
    </div>
  );
}

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function actionTone(action: string): string {
  return ACTION_COLORS[action] ?? "text-zinc-400";
}

export function SyncLine({
  action,
  path,
  counter,
  idle = false,
  running = false,
  idleText = "Idle — ready to sync",
  className = "",
}: {
  action: string | null;
  path: string | null;
  counter?: string | null;
  idle?: boolean;
  running?: boolean;
  idleText?: string;
  className?: string;
}) {
  return (
    <div className={`flex h-6 items-center gap-2 overflow-hidden ${className}`}>
      <span className="inline-flex w-14 shrink-0 justify-center">
        {action ? <ActionChip action={action} /> : null}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ls-mono text-xs ${idle ? "text-zinc-500" : "text-zinc-600 dark:text-zinc-300"}`}
        title={path ?? undefined}
      >
        {idle ? idleText : (path ?? (running ? "Working..." : ""))}
      </span>
      {counter ? (
        <span className="shrink-0 ls-mono text-[10px] tabular-nums text-zinc-500">{counter}</span>
      ) : null}
    </div>
  );
}

export function ReservedBar({
  percent,
  indeterminate = false,
  tone = "violet",
  className = "",
}: {
  percent: number | null;
  indeterminate?: boolean;
  tone?: "violet" | "emerald" | "red";
  className?: string;
}) {
  return (
    <ProgressBar
      percent={percent}
      indeterminate={indeterminate}
      tone={tone}
      className={className}
    />
  );
}

export { ACTION_BG, ACTION_COLORS };
