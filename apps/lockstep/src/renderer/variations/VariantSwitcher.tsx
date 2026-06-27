import { ArrowRight, FlaskConical } from "lucide-react";
import { useEffect, useState } from "react";

import type { LockstepController } from "../hooks/useLockstepController";

const STORAGE_KEY = "lockstep.designTrial.variant";
const VARIANTS = [
  { id: 1, name: "Sidebar Console" },
  { id: 2, name: "Top Toolbar" },
  { id: 3, name: "Three-Pane" },
  { id: 4, name: "Pipeline" },
  { id: 5, name: "Single Surface" },
] as const;

export function usePersistentVariant(): [number, (variant: number) => void] {
  const [variant, setVariant] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : 1;
    return Number.isNaN(parsed) || parsed < 1 || parsed > VARIANTS.length ? 1 : parsed;
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(variant));
  }, [variant]);

  return [variant, setVariant];
}

export function VariantSwitcher({
  ctrl,
  variant,
  onChange,
}: {
  ctrl: LockstepController;
  variant: number;
  onChange: (variant: number) => void;
}) {
  const current = VARIANTS.find((entry) => entry.id === variant) ?? VARIANTS[0];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-3">
      <div className="ls-surface pointer-events-auto flex items-center gap-1.5 px-2 py-1.5 shadow-xl">
        <span className="inline-flex items-center gap-1 pl-1 pr-1.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
          <FlaskConical className="size-3" aria-hidden />
          trials
        </span>
        <div className="flex items-center gap-0.5">
          {VARIANTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => onChange(entry.id)}
              title={entry.name}
              className={`flex size-6 items-center justify-center rounded text-[11px] font-medium transition ${
                entry.id === variant
                  ? "bg-violet-500/25 text-violet-700 dark:text-violet-200"
                  : "text-zinc-500 hover:bg-zinc-200/70 dark:text-zinc-400 dark:hover:bg-zinc-800/70"
              }`}
            >
              {entry.id}
            </button>
          ))}
        </div>
        <span className="px-1 text-[11px] text-zinc-600 dark:text-zinc-300">{current.name}</span>
        <div className="mx-0.5 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
        <button
          type="button"
          onClick={() => ctrl.startDemoRun()}
          disabled={ctrl.running}
          className="ls-btn ls-btn-primary h-6 px-2 text-[11px]"
          title="Run a simulated push to preview progress UI"
        >
          {ctrl.running ? "Running…" : "Demo run"}
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
