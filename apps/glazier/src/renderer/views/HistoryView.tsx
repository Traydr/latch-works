import type {
  HoldingId,
  PlanStepAction,
  PlanSummary,
  RootId,
} from "@latch-works/glazier-core/contract";
import { ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";

import { useToasts } from "../components/Toasts";
import { EmptyState, Toggle, ViewHeader } from "../components/ui";
import { canUndo, describePlan, useActions } from "../lib/actions";
import { call, desktop } from "../lib/api";
import { useEngine, useEngineQuery } from "../lib/engine-state";
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDay,
  formatTime,
  plural,
  relativeTo,
} from "../lib/format";
import { useNow } from "../lib/hotkeys";

const PAGE_SIZE = 200;

/** Plans of these kinds made one after another within this long read as one session. */
const SESSION_GAP_MS = 10 * 60_000;

const RESOLVE_KINDS = new Set<PlanSummary["kind"]>([
  "resolve-duplicates",
  "resolve-duplicate-sets",
]);

const ACTION_LABELS = {
  hold: "to holding",
  move: "moved",
  rename: "renamed",
  "convert-avif": "to AVIF",
  "convert-animation": "to MP4",
  "convert-video": "to MP4",
  "remove-folder": "folder removed",
} as const satisfies Record<PlanStepAction, string>;

const STATUS_LABELS = {
  draft: "Draft",
  applying: "Running",
  applied: null,
  partial: "Partly done",
  failed: "Failed",
  cancelled: "Stopped",
  undone: "Undone",
} as const satisfies Record<PlanSummary["status"], string | null>;

/** One row of the log: a plan, or a run of single-set resolves made in one sitting. */
interface Entry {
  key: string;
  plans: PlanSummary[];
}

function groupPlans(plans: readonly PlanSummary[]): Entry[] {
  const entries: Entry[] = [];

  for (const plan of plans) {
    const previous = entries.at(-1);
    const last = previous?.plans.at(-1);

    if (
      previous &&
      last &&
      RESOLVE_KINDS.has(plan.kind) &&
      RESOLVE_KINDS.has(last.kind) &&
      last.createdAt - plan.createdAt < SESSION_GAP_MS &&
      canUndo(last) === canUndo(plan)
    ) {
      previous.plans.push(plan);
    } else {
      entries.push({ key: String(plan.id), plans: [plan] });
    }
  }

  return entries;
}

function entryTitle(entry: Entry): string {
  const [first] = entry.plans;

  if (!first) {
    return "";
  }

  if (entry.plans.length === 1) {
    return first.title;
  }

  const sets = entry.plans.reduce((sum, plan) => sum + plan.count, 0);

  return `Resolved ${plural(sets, "duplicate set")}`;
}

function entryDetail(entry: Entry): string {
  if (entry.plans.length === 1 && entry.plans[0]) {
    return describePlan(entry.plans[0]);
  }

  let files = 0;
  let bytes = 0;

  for (const plan of entry.plans) {
    files += plan.held.files;
    bytes += plan.held.bytes;
  }

  return files > 0 ? `${plural(files, "file")} to holding · ${formatBytes(bytes)}` : "";
}

export function HistoryView({ rootId }: { rootId: RootId }) {
  const [tab, setTab] = useState<"changes" | "held">("changes");
  const holding = useEngineQuery("listHolding", { rootId, offset: 0, limit: 1 });
  const { report } = useEngine();
  const toasts = useToasts();
  const held = holding.data;

  const emptyHolding = async () => {
    if (!held || held.total === 0) {
      return;
    }

    const confirmed = await desktop.confirm({
      message: `Move ${plural(held.total, "file")} (${formatBytes(held.totalBytes)}) to the Trash?`,
      detail: "Glazier can't undo this. You can still put them back from the Trash.",
      confirmLabel: "Move to Trash",
      destructive: true,
    });

    if (!confirmed) {
      return;
    }

    try {
      const result = await desktop.emptyHolding(rootId);

      toasts.show(
        result.failed.length > 0
          ? {
              message: `Moved ${plural(result.emptied, "file")} to the Trash; some stayed`,
              detail: result.failed[0] ?? null,
              tone: "error",
            }
          : { message: `Moved ${plural(result.emptied, "file")} to the Trash` },
      );
      holding.refresh();
    } catch (error) {
      report(error);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="History"
        meta={
          held && held.total > 0
            ? `holding ${plural(held.total, "file")} · ${formatBytes(held.totalBytes)}`
            : null
        }
      >
        <Toggle
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: "changes", label: "Changes" },
            { value: "held", label: "Held files", count: held?.total ?? 0 },
          ]}
        />
        <button
          type="button"
          className="ls-btn ls-btn-danger"
          disabled={!held || held.total === 0}
          onClick={() => void emptyHolding()}
        >
          Empty to Trash…
        </button>
      </ViewHeader>
      {tab === "changes" ? <Changes rootId={rootId} /> : <HeldFiles rootId={rootId} />}
    </div>
  );
}

function Changes({ rootId }: { rootId: RootId }) {
  const plans = useEngineQuery("listPlans", { rootId, offset: 0, limit: PAGE_SIZE });
  const [open, setOpen] = useState<string | null>(null);
  const { undoPlan } = useActions();
  const now = useNow();
  const entries = useMemo(() => groupPlans(plans.data ?? []), [plans.data]);

  if (!plans.data) {
    return <EmptyState title="Reading the history…" />;
  }

  if (entries.length === 0) {
    return (
      <EmptyState title="No changes yet">Everything you do here shows up with an Undo.</EmptyState>
    );
  }

  let lastDay = "";

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {entries.map((entry) => {
        const [newest] = entry.plans;

        if (!newest) {
          return null;
        }

        const day = formatDay(newest.createdAt, now);
        const header = day !== lastDay ? day : null;
        const undoable = entry.plans.filter(canUndo);
        const statuses = new Set(entry.plans.map((plan) => STATUS_LABELS[plan.status]));
        const status = statuses.size === 1 ? [...statuses][0] : null;
        const expanded = open === entry.key;

        lastDay = day;

        return (
          <li key={entry.key} data-plan={newest.id} data-status={newest.status}>
            {header ? (
              <div className="ls-label sticky top-0 z-10 border-b ls-divider bg-white px-5 pt-3 pb-1 dark:bg-zinc-950">
                {header}
              </div>
            ) : null}
            <div className="flex items-center gap-3 border-b border-zinc-100 px-5 py-2 text-xs dark:border-zinc-900">
              <button
                type="button"
                className="ls-btn ls-btn-ghost px-1"
                aria-label={expanded ? "Hide files" : "Show files"}
                onClick={() => setOpen(expanded ? null : entry.key)}
              >
                {expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              <span className="ls-mono w-12 shrink-0 text-[10.5px] text-zinc-500 tabular">
                {formatTime(newest.createdAt)}
              </span>
              <span
                className={`w-64 shrink-0 truncate font-medium ${
                  newest.status === "undone" ? "text-zinc-500 line-through" : ""
                }`}
              >
                {entryTitle(entry)}
              </span>
              <span className="ls-mono min-w-0 flex-1 truncate text-[10.5px] text-zinc-500 tabular">
                {entryDetail(entry)}
              </span>
              {status ? (
                <span
                  className={`rounded px-1.5 py-px text-[10.5px] ${
                    status === "Failed" || status === "Partly done"
                      ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                      : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                >
                  {status}
                </span>
              ) : null}
              {undoable.length > 0 ? (
                <button
                  type="button"
                  className="ls-btn py-0.5"
                  onClick={async () => {
                    for (const plan of undoable) {
                      await undoPlan(plan);
                    }
                  }}
                >
                  {undoable.length > 1 ? `Undo all ${undoable.length}` : "Undo"}
                </button>
              ) : null}
            </div>
            {expanded ? (
              <div className="border-b ls-divider bg-zinc-50/60 py-1 dark:bg-zinc-900/30">
                {entry.plans.map((plan) => (
                  <PlanSteps key={plan.id} plan={plan} rootId={rootId} />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PlanSteps({ plan, rootId }: { plan: PlanSummary; rootId: RootId }) {
  const steps = useEngineQuery("planSteps", { planId: plan.id, offset: 0, limit: 500 });
  const { roots } = useEngine();
  const rootPath = roots.find((root) => root.id === rootId)?.path;

  return (
    <table className="w-full table-fixed text-[11px]">
      <colgroup>
        <col className="w-28" />
        <col />
        <col className="w-20" />
        <col className="w-[38%]" />
      </colgroup>
      <tbody>
        {(steps.data?.steps ?? []).map((step) => (
          <tr key={step.id} data-step-status={step.status}>
            <td className="py-0.5 pl-14 text-zinc-500">{ACTION_LABELS[step.action]}</td>
            <td
              className="ls-mono truncate py-0.5 text-[10.5px]"
              title={step.toPath ? `${step.fromPath} → ${step.toPath}` : step.fromPath}
            >
              {relativeTo(rootPath, step.fromPath)}
              {step.toPath && step.action !== "hold" ? (
                <span className="text-zinc-500"> → {step.toPath.split(/[\\/]/).at(-1)}</span>
              ) : null}
            </td>
            <td
              className={`py-0.5 ${
                step.status === "failed"
                  ? "text-red-600 dark:text-red-300"
                  : step.status === "skipped"
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-zinc-500"
              }`}
            >
              {step.status}
            </td>
            <td className="truncate py-0.5 pr-5 text-zinc-500" title={step.message ?? undefined}>
              {step.message ?? ""}
            </td>
          </tr>
        ))}
        {steps.data && steps.data.total > steps.data.steps.length ? (
          <tr>
            <td colSpan={4} className="py-1 pl-14 text-zinc-500">
              and {formatCount(steps.data.total - steps.data.steps.length)} more
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function HeldFiles({ rootId }: { rootId: RootId }) {
  const [offset, setOffset] = useState(0);
  const holding = useEngineQuery("listHolding", { rootId, offset, limit: PAGE_SIZE });
  const [selected, setSelected] = useState<Set<HoldingId>>(new Set());
  const { report, roots } = useEngine();
  const toasts = useToasts();
  const root = roots.find((candidate) => candidate.id === rootId);
  const data = holding.data;

  const restore = async (ids: HoldingId[]) => {
    try {
      const result = await call("restoreHolding", { ids });

      setSelected(new Set());
      toasts.show(
        result.failed.length > 0
          ? {
              message: `Restored ${plural(result.restored, "file")}; ${formatCount(result.failed.length)} could not go back`,
              detail: result.failed[0] ?? null,
              tone: "error",
            }
          : { message: `Restored ${plural(result.restored, "file")}` },
      );
      holding.refresh();
    } catch (error) {
      report(error);
    }
  };

  if (!data) {
    return <EmptyState title="Reading the holding folder…" />;
  }

  if (data.total === 0) {
    return (
      <EmptyState title="Nothing is held">
        Removed files and replaced originals wait here until you empty them to the Trash.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-12" />
            <col />
            <col className="w-[30%]" />
            <col className="w-20" />
            <col className="w-40" />
            <col className="w-28" />
          </colgroup>
          <thead className="sticky top-0 bg-white dark:bg-zinc-950">
            <tr className="text-left text-[10px] tracking-wide text-zinc-500 uppercase">
              <th className="px-5 py-1.5">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  className="accent-violet-600"
                  checked={selected.size === data.items.length}
                  onChange={(event) =>
                    setSelected(
                      new Set(event.target.checked ? data.items.map((item) => item.id) : []),
                    )
                  }
                />
              </th>
              <th className="py-1.5">Original path</th>
              <th className="py-1.5">Why</th>
              <th className="py-1.5 pr-4 text-right">Size</th>
              <th className="py-1.5">Held</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {data.items.map((item) => (
              <tr key={item.id} data-holding={item.originalPath}>
                <td className="px-5 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.originalPath}`}
                    className="accent-violet-600"
                    checked={selected.has(item.id)}
                    onChange={(event) => {
                      const next = new Set(selected);

                      if (event.target.checked) {
                        next.add(item.id);
                      } else {
                        next.delete(item.id);
                      }

                      setSelected(next);
                    }}
                  />
                </td>
                <td className="ls-mono truncate py-1.5 text-[11px]" title={item.originalPath}>
                  {relativeTo(root?.path, item.originalPath)}
                </td>
                <td className="truncate py-1.5 text-zinc-500" title={item.reason}>
                  {item.reason}
                </td>
                <td className="ls-mono py-1.5 pr-4 text-right text-[10.5px] tabular">
                  {formatBytes(item.size)}
                </td>
                <td className="ls-mono py-1.5 text-[10.5px] text-zinc-500 tabular">
                  {formatDateTime(item.heldAt)}
                </td>
                <td className="py-1.5 pr-4 text-right">
                  <button
                    type="button"
                    className="ls-btn ls-btn-ghost px-1"
                    aria-label="Show in Finder"
                    title="Show in Finder"
                    onClick={() => void desktop.reveal(item.holdPath)}
                  >
                    <FolderOpen className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="ls-btn ls-btn-ghost py-0"
                    onClick={() => void restore([item.id])}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t ls-divider bg-zinc-50 px-4 py-2 dark:bg-zinc-900/60">
        <span className="ls-mono text-[10.5px] text-zinc-500 tabular">
          {formatCount(offset + 1)}–{formatCount(offset + data.items.length)} of{" "}
          {formatCount(data.total)}
        </span>
        {data.total > PAGE_SIZE ? (
          <>
            <button
              type="button"
              className="ls-btn ls-btn-ghost py-0.5"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="ls-btn ls-btn-ghost py-0.5"
              disabled={offset + PAGE_SIZE >= data.total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="ls-btn ml-auto"
          disabled={selected.size === 0}
          onClick={() => void restore([...selected])}
        >
          Restore {selected.size > 0 ? formatCount(selected.size) : ""}
        </button>
      </div>
    </div>
  );
}
