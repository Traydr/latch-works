import { Search } from "lucide-react";

import type { LockstepPlan, LockstepPlanItem } from "../../shared/types";
import { ActionBadge } from "../components/ActionBadge";
import { AlertBanner } from "../components/AlertBanner";
import { PlanCountGrid } from "../components/PlanCountGrid";

interface PlanResultsViewProps {
  filter: string;
  items: LockstepPlanItem[];
  onBack: () => void;
  onFilterChange: (value: string) => void;
  plan: LockstepPlan;
}

export function PlanResultsView({
  filter,
  items,
  onBack,
  onFilterChange,
  plan,
}: PlanResultsViewProps) {
  return (
    <section className="prism-section">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Plan results</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {items.length.toLocaleString()} changed item(s) after filtering
          </p>
        </div>
        <button className="prism-btn" type="button" onClick={onBack}>
          Back to dashboard
        </button>
      </div>

      <PlanCountGrid counts={plan.counts} compact />

      {plan.counts.delete > 0 ? (
        <div className="mt-4">
          <AlertBanner
            variant="warning"
            message={`${plan.counts.delete} remote delete(s) are planned. Push will not apply them — use Apply deletes separately after review.`}
          />
        </div>
      ) : null}

      <label className="mt-4 grid gap-1.5">
        <span className="prism-label">Filter changed items</span>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400"
            aria-hidden
          />
          <input
            className="prism-input pl-9"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Search by path"
          />
        </div>
      </label>

      <div className="mt-4 max-h-[28rem] overflow-auto rounded-2xl border border-zinc-300/70 dark:border-zinc-700/70">
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No changed items match this filter.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200/80 dark:divide-zinc-800/80">
            {items.map((item) => (
              <li
                key={`${item.action}:${item.path}`}
                className="grid grid-cols-[5.5rem_1fr] items-center gap-3 px-4 py-2.5"
              >
                <ActionBadge action={item.action} />
                <span className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-200">
                  {item.path}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
