import { ArrowUpCircle, Play, Stethoscope, Trash2 } from "lucide-react";

interface ActionDockProps {
  disabled?: boolean;
  onDoctor: () => void;
  onPlan: () => void;
  onPrune: () => void;
  onPush: () => void;
}

export function ActionDock({ disabled = false, onDoctor, onPlan, onPrune, onPush }: ActionDockProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="prism-surface pointer-events-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Push never applies deletes. Review the plan, then use Apply deletes explicitly.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button className="prism-btn inline-flex items-center gap-1.5" disabled={disabled} type="button" onClick={onDoctor}>
            <Stethoscope className="size-3.5" aria-hidden />
            Test connection
          </button>
          <button className="prism-btn prism-btn-primary inline-flex items-center gap-1.5" disabled={disabled} type="button" onClick={onPlan}>
            <Play className="size-3.5" aria-hidden />
            Plan
          </button>
          <button className="prism-btn prism-btn-primary inline-flex items-center gap-1.5" disabled={disabled} type="button" onClick={onPush}>
            <ArrowUpCircle className="size-3.5" aria-hidden />
            Push uploads/updates
          </button>
          <button className="prism-btn prism-btn-danger inline-flex items-center gap-1.5" disabled={disabled} type="button" onClick={onPrune}>
            <Trash2 className="size-3.5" aria-hidden />
            Apply deletes
          </button>
        </div>
      </div>
    </div>
  );
}
