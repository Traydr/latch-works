import { formatBytes } from "@latch-works/media-domain";
import { ArrowUp, Lock, RotateCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { LockstepPlan, LockstepProfilePublic } from "../../shared/types";
import type {
  PlanController,
  RunController,
  SessionController,
} from "../hooks/useLockstepController";
import { formatAgo } from "../lib/run-formatters";
import { DoctorCheckList } from "./DoctorCheckList";
import { PlanTree } from "./PlanTree";
import { ACTION_DOT, Spinner, useNow } from "./syncPrimitives";
import { TokenInput } from "./TokenInput";

type ChangeAction = "upload" | "update" | "delete";

const CHANGE_ACTIONS = ["upload", "update", "delete"] as const satisfies readonly ChangeAction[];

const CHIP_TONE = {
  upload: "border-sky-500/50 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  update: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  delete: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300",
} satisfies Record<ChangeAction, string>;

type RunFilter = "all" | "remaining" | "done" | "failed";

const RUN_FILTERS = ["all", "remaining", "done", "failed"] as const satisfies readonly RunFilter[];

export const PLAN_FILTER_INPUT_ID = "plan-path-filter";

interface PlanWorkspaceProps {
  profile: LockstepProfilePublic;
  session: SessionController;
  plan: PlanController;
  run: RunController;
  /** The run panel is open on a push or prune, so rows show their run state. */
  showRunState: boolean;
}

export function PlanWorkspace({ profile, session, plan, run, showRunState }: PlanWorkspaceProps) {
  const current = plan.plan;

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {current ? (
        <PlanView
          key={current.planId}
          current={current}
          profile={profile}
          plan={plan}
          run={run}
          showRunState={showRunState}
        />
      ) : (
        <NoPlan profile={profile} run={run} />
      )}
      {!profile.tokenConfigured || plan.doctorResult ? (
        <div className="flex shrink-0 flex-col gap-3 border-t border-zinc-200 p-3 dark:border-zinc-800">
          <TokenInput
            value={session.sessionToken}
            onChange={session.setSessionToken}
            profile={profile}
          />
          {plan.doctorResult ? (
            <section aria-label="Doctor">
              <div className="mb-2 flex items-center">
                <span className="ls-label">
                  Doctor · {plan.doctorResult.ok ? "all checks passed" : "some checks failed"}
                </span>
                <button
                  type="button"
                  className="ls-btn ls-btn-ghost ml-auto h-5 px-1"
                  onClick={plan.dismissDoctorResult}
                  title="Dismiss doctor result"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </div>
              <div className="max-h-40 overflow-auto">
                <DoctorCheckList result={plan.doctorResult} />
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function NoPlan({ profile, run }: { profile: LockstepProfilePublic; run: RunController }) {
  const planning = run.running && run.runProgress.kind === "plan";

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">No plan yet</h2>
      <p className="max-w-sm text-xs leading-relaxed text-zinc-500">
        Plan scans{" "}
        <span className="ls-mono text-zinc-700 dark:text-zinc-300">{profile.sourceRoot}</span> and
        compares it with{" "}
        <span className="ls-mono text-zinc-700 dark:text-zinc-300">{profile.apiUrl}</span>. Nothing
        changes on the server until you push.
      </p>
      <button
        type="button"
        data-action="plan"
        className="ls-btn ls-btn-cta h-8 px-4"
        disabled={run.running}
        onClick={() => void run.handlePlan()}
      >
        {planning ? <Spinner className="border-white/30 border-t-white" /> : null}
        {planning ? "Planning…" : "Plan"}
      </button>
    </div>
  );
}

function PlanView({
  current,
  profile,
  plan,
  run,
  showRunState,
}: {
  current: LockstepPlan;
  profile: LockstepProfilePublic;
  plan: PlanController;
  run: RunController;
  showRunState: boolean;
}) {
  const [actionFilter, setActionFilter] = useState<ReadonlySet<ChangeAction>>(() => new Set());
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [showSkipped, setShowSkipped] = useState(false);
  const now = useNow(true, 30_000);

  const bytesByAction = useMemo(() => {
    const bytes = { upload: 0, update: 0, delete: 0, keep: 0 };

    for (const item of current.items) {
      bytes[item.action] += item.size ?? 0;
    }

    return bytes;
  }, [current.items]);

  const { itemStates, itemStatesVersion } = run;

  // biome-ignore lint/correctness/useExhaustiveDependencies: itemStatesVersion versions itemStates.
  const visibleItems = useMemo(() => {
    if (showRunState) {
      if (runFilter === "all") {
        return plan.filteredItems;
      }

      return plan.filteredItems.filter((item) => {
        const state = itemStates.get(item.path)?.type;

        switch (runFilter) {
          case "done":
            return state === "done" || state === "skipped";
          case "failed":
            return state === "failed";
          case "remaining":
            return state === undefined || state === "active";
          default: {
            const _exhaustive: never = runFilter;

            return _exhaustive;
          }
        }
      });
    }

    return actionFilter.size === 0
      ? plan.filteredItems
      : plan.filteredItems.filter(
          (item) => item.action !== "keep" && actionFilter.has(item.action),
        );
  }, [actionFilter, itemStates, itemStatesVersion, plan.filteredItems, runFilter, showRunState]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: itemStatesVersion versions itemStates.
  const runCounts = useMemo(() => {
    const counts = { all: plan.filteredItems.length, remaining: 0, done: 0, failed: 0 };

    for (const item of plan.filteredItems) {
      const state = itemStates.get(item.path)?.type;

      if (state === "done" || state === "skipped") {
        counts.done += 1;
      } else if (state === "failed") {
        counts.failed += 1;
      } else {
        counts.remaining += 1;
      }
    }

    return counts;
  }, [itemStates, itemStatesVersion, plan.filteredItems]);

  const toggleAction = (action: ChangeAction) => {
    setActionFilter((selected) => {
      const next = new Set(selected);

      if (!next.delete(action)) {
        next.add(action);
      }

      return next;
    });
  };

  const pushCount = current.counts.upload + current.counts.update;
  const pushBytes = bytesByAction.upload + bytesByAction.update;
  const prune = plan.pruneAvailability;
  const pushed = plan.pipelineProgress.pushCompleted;
  const changeCount = pushCount + current.counts.delete;

  return (
    <>
      <header className="shrink-0 border-b border-zinc-200 px-3 pt-2.5 pb-2 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">Plan</h2>
          <span className="truncate ls-mono text-[10.5px] text-zinc-500">
            {plan.plannedAt ? `${formatAgo(plan.plannedAt, now)} · ` : ""}
            {current.totalFiles.toLocaleString()} files · {formatBytes(current.totalBytes)}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              data-action="plan"
              className={`ls-btn h-7 ${pushed && !showRunState ? "ls-btn-cta px-3" : "ls-btn-ghost"}`}
              disabled={run.running}
              onClick={() => void run.handlePlan()}
            >
              <RotateCw className="size-3" aria-hidden /> Re-plan
            </button>
            {current.counts.delete > 0 ? (
              <button
                type="button"
                data-action="prune"
                className={`ls-btn h-7 ${prune.enabled ? "ls-btn-danger" : ""}`}
                disabled={run.running || !prune.enabled}
                title={
                  prune.enabled
                    ? `Delete the ${prune.deleteCount.toLocaleString()} remote entries this plan lists`
                    : prune.reason
                }
                onClick={() => void run.handlePrune()}
              >
                {prune.enabled ? null : <Lock className="size-3" aria-hidden />}
                Prune {current.counts.delete.toLocaleString()}
                {prune.enabled ? "…" : ""}
              </button>
            ) : null}
            {pushed ? null : (
              <button
                type="button"
                data-action="push"
                className="ls-btn ls-btn-cta h-7 px-3"
                disabled={run.running || pushCount === 0}
                onClick={() => void run.handlePush()}
              >
                <ArrowUp className="size-3" aria-hidden />
                {pushCount === 0
                  ? "Nothing to push"
                  : `Push ${pushCount.toLocaleString()} · ${formatBytes(pushBytes)}`}
              </button>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate ls-mono text-[10.5px] text-zinc-500" title={profile.apiUrl}>
          {current.sourceRoot} → {profile.apiUrl}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          {showRunState ? (
            <div className="flex items-center gap-1" role="tablist" aria-label="Run filter">
              {RUN_FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  role="tab"
                  aria-selected={runFilter === filter}
                  onClick={() => setRunFilter(filter)}
                  className={`rounded px-2 py-1 text-xs capitalize transition ${runFilter === filter ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"} ${filter === "failed" && runCounts.failed > 0 ? "text-red-600 dark:text-red-300" : ""}`}
                >
                  {filter} {runCounts[filter].toLocaleString()}
                </button>
              ))}
            </div>
          ) : (
            CHANGE_ACTIONS.map((action) =>
              current.counts[action] > 0 ? (
                <button
                  key={action}
                  type="button"
                  aria-pressed={actionFilter.has(action)}
                  data-plan-count={action}
                  data-count={current.counts[action]}
                  onClick={() => toggleAction(action)}
                  title={`Show only ${action}s`}
                  className={`inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 ls-mono text-[10.5px] tabular-nums transition ${actionFilter.has(action) || actionFilter.size === 0 ? CHIP_TONE[action] : "border-zinc-300 text-zinc-500 dark:border-zinc-700"} ${actionFilter.has(action) ? "ring-1 ring-current" : ""}`}
                >
                  <span className={`size-1.5 rounded-full ${ACTION_DOT[action]}`} aria-hidden />
                  {current.counts[action].toLocaleString()} {action}
                  {action === "delete" ? "" : ` · ${formatBytes(bytesByAction[action])}`}
                </button>
              ) : (
                <span key={action} data-plan-count={action} data-count={0} hidden />
              ),
            )
          )}
          <label className="relative ml-auto w-56 max-w-[40%]">
            <span className="sr-only">Filter plan paths</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-zinc-500"
              aria-hidden
            />
            <input
              id={PLAN_FILTER_INPUT_ID}
              className="ls-input h-[24px] py-0 text-xs"
              style={{ paddingLeft: 24, paddingRight: 24 }}
              value={plan.filter}
              onChange={(event) => plan.setFilter(event.target.value)}
              placeholder="Filter paths…"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-zinc-300 px-1 ls-mono text-[9.5px] text-zinc-500 dark:border-zinc-700">
              /
            </kbd>
          </label>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PlanTree
          items={visibleItems}
          itemStates={showRunState ? itemStates : null}
          itemStatesVersion={itemStatesVersion}
          emptyHint={
            changeCount === 0
              ? "Everything is in sync. Nothing to push or prune."
              : "No changed items match this filter."
          }
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 ls-mono text-[10.5px] text-zinc-500">
          <span data-plan-count="keep" data-count={current.counts.keep}>
            {current.counts.keep.toLocaleString()} unchanged
          </span>
          {current.skipped > 0 ? (
            <button
              type="button"
              className="underline decoration-zinc-400 underline-offset-2 hover:text-zinc-800 dark:decoration-zinc-600 dark:hover:text-zinc-200"
              aria-expanded={showSkipped}
              onClick={() => setShowSkipped((open) => !open)}
            >
              {current.skipped.toLocaleString()} skipped · {showSkipped ? "hide" : "why?"}
            </button>
          ) : null}
        </div>
        {showSkipped ? (
          <ul className="px-3 pb-3 ls-mono text-[10.5px] text-zinc-500">
            {current.skippedEntries.map((entry) => (
              <li key={entry.path} className="flex gap-2 py-0.5">
                <span className="truncate text-zinc-700 dark:text-zinc-300">{entry.path}</span>
                <span className="shrink-0">{entry.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
