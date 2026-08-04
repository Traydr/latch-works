import { Search } from "lucide-react";

import type { LockstepProfilePublic } from "../../shared/types";
import type { PlanController } from "../hooks/useLockstepController";
import { ActionChip } from "./syncPrimitives";

export function TokenInput({
  value,
  onChange,
  profile,
}: {
  value: string;
  onChange: (value: string) => void;
  profile: LockstepProfilePublic;
}) {
  if (profile.tokenConfigured) {
    return null;
  }
  return (
    <label className="grid gap-1">
      <span className="ls-label">Sync API token</span>
      <input
        className="ls-input"
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Enter token for this session"
      />
      <p className="text-[10px] text-zinc-500">
        {profile.tokenUnreadable
          ? "Stored token could not be unlocked. Re-enter to save securely."
          : "OS encryption unavailable — token stays in memory until quit."}
      </p>
    </label>
  );
}

export function PlanList({
  plan,
  className = "",
  emptyHint = "No changed items match this filter.",
}: {
  plan: PlanController;
  className?: string;
  emptyHint?: string;
}) {
  const { filter, setFilter, filteredItems } = plan;
  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <label className="ls-label" htmlFor="plan-path-filter">
        Filter plan paths
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500"
          aria-hidden
        />
        <input
          id="plan-path-filter"
          className="ls-input pl-8"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by path"
        />
      </div>
      <div className="ls-surface-2 min-h-0 flex-1 overflow-auto">
        {filteredItems.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">{emptyHint}</p>
        ) : (
          <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70">
            {filteredItems.map((item) => (
              <li
                key={`${item.action}:${item.path}`}
                className="flex items-center gap-2 px-2.5 py-1.5"
              >
                <ActionChip action={item.action} className="w-14 shrink-0" />
                <span className="truncate ls-mono text-xs text-zinc-600 dark:text-zinc-300">
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

export function PlanLegend({
  counts,
  className = "",
}: {
  counts: { upload: number; update: number; delete: number; keep: number };
  className?: string;
}) {
  const entries: Array<{ key: string; label: string; value: number; dot: string }> = [
    { key: "upload", label: "upload", value: counts.upload, dot: "bg-sky-500" },
    { key: "update", label: "update", value: counts.update, dot: "bg-amber-500" },
    { key: "delete", label: "delete", value: counts.delete, dot: "bg-red-500" },
    { key: "keep", label: "keep", value: counts.keep, dot: "bg-zinc-600" },
  ];
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      {entries.map((entry) => (
        <span key={entry.key} className="inline-flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${entry.dot}`} aria-hidden />
          <span className="ls-mono text-[10px] text-zinc-500">{entry.label}</span>
          <span className="ls-mono text-[10px] font-medium tabular-nums text-zinc-300">
            {entry.value}
          </span>
        </span>
      ))}
    </div>
  );
}
