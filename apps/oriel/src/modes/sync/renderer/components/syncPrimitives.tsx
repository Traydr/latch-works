import { useEffect, useState } from "react";

import { SyncPlanActionSchema } from "../../shared/contracts";
import type { LockstepPlanItem } from "../../shared/types";

type SyncPlanAction = LockstepPlanItem["action"];

export const ACTION_DOT = {
  upload: "bg-sky-500",
  update: "bg-amber-500",
  delete: "bg-red-500",
  keep: "bg-zinc-400 dark:bg-zinc-500",
} satisfies Record<SyncPlanAction, string>;

const ACTION_BADGE = {
  upload: "bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  update: "lw-badge-warn",
  delete: "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  keep: "lw-badge-neutral",
} satisfies Record<SyncPlanAction, string>;

const ACTION_LABEL = {
  upload: "Upload",
  update: "Update",
  delete: "Delete",
  keep: "Keep",
} satisfies Record<SyncPlanAction, string>;

/** A plan item's action as a badge. Run events carry free-form labels; unknown ones read as Keep. */
export function ActionBadge({ action }: { action: string }) {
  const parsed = SyncPlanActionSchema.safeParse(action);
  const known = parsed.success ? parsed.data : "keep";

  return (
    <span className={`lw-badge w-[60px] shrink-0 justify-center ${ACTION_BADGE[known]}`}>
      {parsed.success ? ACTION_LABEL[known] : action}
    </span>
  );
}

export type ProgressTone = "violet" | "emerald" | "red";

const TONE_FILL = {
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  red: "bg-red-500",
} satisfies Record<ProgressTone, string>;

/** The house progress bar, with a tone for how a finished run ended; null `percent` is unknown. */
export function ProgressBar({
  percent,
  tone = "violet",
  className = "",
}: {
  percent: number | null;
  tone?: ProgressTone;
  className?: string;
}) {
  return (
    <div
      className={`relative h-1 w-full overflow-hidden rounded-full bg-zinc-900/[0.07] dark:bg-white/[0.08] ${className}`}
    >
      {percent === null ? (
        <div className={`absolute inset-y-0 w-1/3 animate-pulse rounded-full ${TONE_FILL[tone]}`} />
      ) : (
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${TONE_FILL[tone]}`}
          style={{ width: `${Math.max(0, Math.min(100, percent * 100))}%` }}
        />
      )}
    </div>
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
