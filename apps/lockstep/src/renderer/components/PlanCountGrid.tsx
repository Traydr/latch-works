import type { LockstepPlanCounts } from "../../shared/types";

interface PlanCountGridProps {
  counts: LockstepPlanCounts;
  compact?: boolean;
}

const labels: Array<{ key: keyof LockstepPlanCounts; label: string }> = [
  { key: "upload", label: "Upload" },
  { key: "update", label: "Update" },
  { key: "keep", label: "Keep" },
  { key: "delete", label: "Delete" },
];

export function PlanCountGrid({ counts, compact = false }: PlanCountGridProps) {
  const items = compact ? labels.filter((entry) => entry.key !== "keep") : labels;

  return (
    <div className={`grid gap-3 ${compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}>
      {items.map((entry) => (
        <div key={entry.key} className="prism-stat">
          <p className="prism-label">{entry.label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">{counts[entry.key]}</p>
        </div>
      ))}
    </div>
  );
}
