import { useEffect, useState } from "react";

import { SyncPlanActionSchema } from "../../shared/contracts";
import type { LockstepPlanItem } from "../../shared/types";

type SyncPlanAction = LockstepPlanItem["action"];

export const ACTION_DOT = {
  upload: "bg-sky-500",
  update: "bg-amber-500",
  delete: "bg-red-500",
  keep: "bg-zinc-500",
} satisfies Record<SyncPlanAction, string>;

const ACTION_CHIP = {
  upload: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  update: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  delete: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  keep: "border-zinc-400/50 bg-zinc-500/10 text-zinc-500 dark:border-zinc-600/50 dark:text-zinc-400",
} satisfies Record<SyncPlanAction, string>;

/** Run events carry free-form action labels; unknown ones fall back to the neutral chip. */
function actionChipClass(action: string): string {
  const parsed = SyncPlanActionSchema.safeParse(action);

  return parsed.success ? ACTION_CHIP[parsed.data] : ACTION_CHIP.keep;
}

export function ActionChip({ action, className = "" }: { action: string; className?: string }) {
  return (
    <span
      className={`inline-flex w-14 shrink-0 items-center justify-center rounded border px-1.5 py-px font-mono text-[9.5px] font-medium tracking-wide uppercase ${actionChipClass(action)} ${className}`}
    >
      {action}
    </span>
  );
}

export type ProgressTone = "violet" | "emerald" | "red";

const TONE_FILL = {
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  red: "bg-red-500",
} satisfies Record<ProgressTone, string>;

export function ProgressBar({
  percent,
  indeterminate = false,
  tone = "violet",
  className = "",
}: {
  percent: number | null;
  indeterminate?: boolean;
  tone?: ProgressTone;
  className?: string;
}) {
  const width = percent == null ? 0 : Math.max(0, Math.min(100, percent * 100));

  return (
    <div
      className={`relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${className}`}
    >
      {indeterminate ? (
        <div
          className={`absolute inset-y-0 w-1/3 animate-[ls-indeterminate_1.1s_ease-in-out_infinite] rounded-full ${TONE_FILL[tone]}`}
        />
      ) : (
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out ${TONE_FILL[tone]}`}
          style={{ width: `${width}%` }}
        />
      )}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-violet-400/30 border-t-violet-500 dark:border-t-violet-300 ${className}`}
      aria-hidden
    />
  );
}

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);

    return () => clearInterval(id);
  }, [active, intervalMs]);

  return now;
}
