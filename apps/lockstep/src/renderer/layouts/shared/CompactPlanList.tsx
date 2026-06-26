import { Search } from "lucide-react";

import type { LockstepPlanItem } from "../../../shared/types";
import { ActionBadge } from "../../components/ActionBadge";

interface CompactPlanListProps {
  dense?: boolean;
  filter: string;
  items: LockstepPlanItem[];
  onFilterChange: (value: string) => void;
  showFilter?: boolean;
}

export function CompactPlanList({
  dense = false,
  filter,
  items,
  onFilterChange,
  showFilter = true,
}: CompactPlanListProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showFilter ? (
        <label className="mb-2 grid gap-1">
          <span className="prism-label">Filter changed items</span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400"
              aria-hidden
            />
            <input
              className="prism-input py-1.5 pl-8 text-xs"
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder="Search by path"
            />
          </div>
        </label>
      ) : null}

      <div
        className={`min-h-0 flex-1 overflow-auto rounded-xl border border-zinc-300/70 dark:border-zinc-700/70 ${
          dense ? "max-h-64" : ""
        }`}
      >
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            No changed items match this filter.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200/80 dark:divide-zinc-800/80">
            {items.map((item) => (
              <li
                key={`${item.action}:${item.path}`}
                className={`grid grid-cols-[4.5rem_1fr] items-center gap-2 px-3 ${
                  dense ? "py-1.5" : "py-2"
                }`}
              >
                <ActionBadge action={item.action} />
                <span className="truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-200">
                  {item.path}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
