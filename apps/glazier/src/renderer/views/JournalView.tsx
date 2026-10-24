import type { PlanId, PlanKind, PlanSummary, RootId } from "@latch-works/glazier-core/contract";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { EmptyState, ViewHeader } from "../components/ui";
import { call } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import { formatBytes, formatCount, formatDateTime } from "../lib/format";

const KIND_LABELS = {
  hold: "Moved to holding",
  move: "Moved files",
  rename: "Renamed",
  "fix-extension": "Fixed extensions",
  optimize: "Converted to archive formats",
  reencode: "Re-encoded videos",
  "strip-audio": "Stripped audio",
  "resolve-duplicates": "Resolved duplicates",
  "clean-junk": "Cleaned system junk",
  "remove-empty-folders": "Removed empty folders",
} as const satisfies Record<PlanKind, string>;

function canUndo(plan: PlanSummary): boolean {
  return (
    plan.done > 0 &&
    (plan.status === "applied" || plan.status === "partial" || plan.status === "cancelled")
  );
}

export function JournalView({ rootId }: { rootId: RootId }) {
  const plans = useEngineQuery("listPlans", { rootId, offset: 0, limit: 100 });
  const [open, setOpen] = useState<PlanId | null>(null);
  const { report } = useEngine();

  if (!plans.data || plans.data.length === 0) {
    return (
      <EmptyState title="Nothing applied yet">
        Every plan you apply is recorded here, step by step, and can be undone.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Journal"
        description="Every applied plan, newest first. Undo reverses its finished steps."
      />
      <ul className="min-h-0 flex-1 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-900">
        {plans.data.map((plan) => (
          <li key={plan.id} data-plan={plan.id} data-status={plan.status}>
            <div className="flex items-center gap-3 px-5 py-2 text-xs">
              <button
                type="button"
                className="ls-btn ls-btn-ghost px-1"
                aria-label={open === plan.id ? "Hide steps" : "Show steps"}
                onClick={() => setOpen(open === plan.id ? null : plan.id)}
              >
                {open === plan.id ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              <span className="w-48 font-medium">{KIND_LABELS[plan.kind]}</span>
              <span className="w-36 text-zinc-500">{formatDateTime(plan.createdAt)}</span>
              <span className="w-20 capitalize">{plan.status}</span>
              <span className="tabular min-w-0 flex-1 text-zinc-500">
                {formatCount(plan.done)} done
                {plan.skipped > 0 ? ` · ${formatCount(plan.skipped)} skipped` : ""}
                {plan.failed > 0 ? ` · ${formatCount(plan.failed)} failed` : ""}
                {plan.undone > 0 ? ` · ${formatCount(plan.undone)} undone` : ""}
                {plan.bytesBefore > 0
                  ? ` · ${formatBytes(plan.bytesBefore)} → ${formatBytes(plan.bytesAfter)}`
                  : ""}
              </span>
              <button
                type="button"
                className="ls-btn"
                disabled={!canUndo(plan)}
                onClick={() => {
                  if (
                    window.confirm("Undo this plan? Its finished steps are reversed, newest first.")
                  ) {
                    void call("undoPlan", { planId: plan.id }).catch(report);
                  }
                }}
              >
                Undo
              </button>
            </div>
            {open === plan.id ? <PlanSteps planId={plan.id} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanSteps({ planId }: { planId: PlanId }) {
  const steps = useEngineQuery("planSteps", { planId, offset: 0, limit: 500 });

  return (
    <table className="mb-2 w-full text-[11px]">
      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
        {(steps.data?.steps ?? []).map((step) => (
          <tr key={step.id} data-step-status={step.status}>
            <td className="w-24 py-1 pl-14 text-zinc-500">{step.action}</td>
            <td
              className="max-w-0 truncate py-1"
              title={step.toPath ? `${step.fromPath} → ${step.toPath}` : step.fromPath}
            >
              {step.fromPath}
              {step.toPath ? (
                <span className="text-zinc-500"> → {step.toPath.split(/[\\/]/).at(-1)}</span>
              ) : null}
            </td>
            <td className="w-20 py-1 capitalize">{step.status}</td>
            <td className="max-w-0 truncate py-1 pr-5 text-zinc-500">{step.message ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
