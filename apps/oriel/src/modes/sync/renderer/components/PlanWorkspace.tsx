import { formatBytes } from "@latch-works/media-domain";
import { ArrowUp, Lock, MoreHorizontal, RotateCw, Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { EmptyState, Kbd, Menu, MenuSeparator, Spinner, TopBar } from "../../../../ui/ui";
import type { LockstepPlan, LockstepProfilePublic } from "../../shared/types";
import type {
  PlanController,
  ProfileController,
  RunController,
  SessionController,
} from "../hooks/useLockstepController";
import { describeLastRun } from "../lib/profile-status";
import { formatAgo } from "../lib/run-formatters";
import { AlertBanner } from "./AlertBanner";
import { DoctorCheckList } from "./DoctorCheckList";
import { PlanTree } from "./PlanTree";
import { ACTION_DOT, useNow } from "./syncPrimitives";
import { TokenInput } from "./TokenInput";

type ChangeAction = "upload" | "update" | "delete";

const CHANGE_ACTIONS = ["upload", "update", "delete"] as const satisfies readonly ChangeAction[];

const CHANGE_LABEL = {
  upload: "upload",
  update: "update",
  delete: "delete",
} satisfies Record<ChangeAction, string>;

type RunFilter = "all" | "remaining" | "done" | "failed";

const RUN_FILTERS = [
  { value: "all", label: "All" },
  { value: "remaining", label: "Remaining" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
] as const satisfies ReadonlyArray<{ value: RunFilter; label: string }>;

export const PLAN_FILTER_INPUT_ID = "plan-path-filter";

interface PlanWorkspaceProps {
  profile: LockstepProfilePublic;
  session: SessionController;
  profiles: ProfileController;
  plan: PlanController;
  run: RunController;
  /** The run panel is open on a push or prune, so rows show their run state. */
  showRunState: boolean;
  onToggleLog: () => void;
}

/** The active profile's page: its plan, or the empty state before one, under its top bar. */
export function PlanWorkspace({
  profile,
  session,
  profiles,
  plan,
  run,
  showRunState,
  onToggleLog,
}: PlanWorkspaceProps) {
  const current = plan.plan;
  const now = useNow(true, 30_000);

  const meta = current
    ? [
        plan.plannedAt ? `Planned ${formatAgo(plan.plannedAt, now)}` : null,
        `${current.totalFiles.toLocaleString()} files`,
        formatBytes(current.totalBytes),
      ]
        .filter(Boolean)
        .join(" · ")
    : describeLastRun(profile, now);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TopBar title={profile.name} meta={meta}>
        <ProfileMenu profile={profile} profiles={profiles} run={run} onToggleLog={onToggleLog} />
        {current ? (
          <PlanActions current={current} plan={plan} run={run} showRunState={showRunState} />
        ) : null}
      </TopBar>
      {session.error ? (
        <div className="shrink-0 px-5 pt-3">
          <AlertBanner message={session.error} />
        </div>
      ) : null}
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
        <div className="flex shrink-0 flex-col gap-4 border-t lw-divider px-5 py-4">
          <TokenInput
            value={session.sessionToken}
            onChange={session.setSessionToken}
            profile={profile}
          />
          {plan.doctorResult ? (
            <section aria-label="Connection check">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="lw-heading">
                  {plan.doctorResult.ok ? "Every check passed" : "Some checks failed"}
                </h2>
                <button
                  type="button"
                  className="lw-btn lw-btn-ghost lw-btn-icon-sm ml-auto"
                  onClick={plan.dismissDoctorResult}
                  title="Dismiss"
                  aria-label="Dismiss the connection check"
                >
                  <X />
                </button>
              </div>
              <div className="max-h-48 overflow-auto">
                <DoctorCheckList result={plan.doctorResult} />
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/** The profile's own actions, which Lockstep kept in the profile rail's menu. */
function ProfileMenu({
  profile,
  profiles,
  run,
  onToggleLog,
}: {
  profile: LockstepProfilePublic;
  profiles: ProfileController;
  run: RunController;
  onToggleLog: () => void;
}) {
  const item = (label: ReactNode, action: () => void, close: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="lw-menu-item"
      disabled={disabled}
      onClick={() => {
        close();
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <Menu icon variant="ghost" title="Profile actions" label={<MoreHorizontal />}>
      {(close) => (
        <>
          {item("Edit profile…", () => profiles.startEditProfile(profile.id), close, run.running)}
          {item("Check connection", () => void run.handleDoctor(), close, run.running)}
          {item(
            <>
              Run log <span className="lw-menu-meta">⌘L</span>
            </>,
            onToggleLog,
            close,
          )}
          <MenuSeparator />
          {item(
            <span className="text-red-600 dark:text-red-400">Delete profile…</span>,
            () => void profiles.handleDeleteProfile(profile.id),
            close,
            run.running,
          )}
        </>
      )}
    </Menu>
  );
}

function PlanActions({
  current,
  plan,
  run,
  showRunState,
}: {
  current: LockstepPlan;
  plan: PlanController;
  run: RunController;
  showRunState: boolean;
}) {
  const pushCount = current.counts.upload + current.counts.update;

  const pushBytes = current.items.reduce(
    (sum, item) =>
      item.action === "upload" || item.action === "update" ? sum + (item.size ?? 0) : sum,
    0,
  );

  const prune = plan.pruneAvailability;
  const pushed = plan.pipelineProgress.pushCompleted;

  return (
    <>
      <button
        type="button"
        data-action="plan"
        className={`lw-btn ${pushed && !showRunState ? "lw-btn-primary" : "lw-btn-secondary"}`}
        disabled={run.running}
        onClick={() => void run.handlePlan()}
      >
        <RotateCw /> Re-plan
      </button>
      {current.counts.delete > 0 ? (
        <button
          type="button"
          data-action="prune"
          className={`lw-btn ${prune.enabled ? "lw-btn-danger" : "lw-btn-secondary"}`}
          disabled={run.running || !prune.enabled}
          title={
            prune.enabled
              ? `Delete the ${prune.deleteCount.toLocaleString()} remote entries this plan lists`
              : prune.reason
          }
          onClick={() => void run.handlePrune()}
        >
          {prune.enabled ? null : <Lock />}
          Prune {current.counts.delete.toLocaleString()}
          {prune.enabled ? "…" : ""}
        </button>
      ) : null}
      {pushed ? null : (
        <button
          type="button"
          data-action="push"
          className="lw-btn lw-btn-primary"
          disabled={run.running || pushCount === 0}
          onClick={() => void run.handlePush()}
        >
          <ArrowUp />
          {pushCount === 0
            ? "Nothing to push"
            : `Push ${pushCount.toLocaleString()} · ${formatBytes(pushBytes)}`}
        </button>
      )}
    </>
  );
}

function NoPlan({ profile, run }: { profile: LockstepProfilePublic; run: RunController }) {
  const planning = run.running && run.runProgress.kind === "plan";

  return (
    <EmptyState
      title="No plan yet"
      actions={
        <button
          type="button"
          data-action="plan"
          className="lw-btn lw-btn-primary lw-btn-lg"
          disabled={run.running}
          onClick={() => void run.handlePlan()}
        >
          {planning ? <Spinner className="border-white/30 border-t-white" /> : null}
          {planning ? "Planning…" : "Plan"}
        </button>
      }
    >
      Plan compares <span className="text-zinc-800 dark:text-zinc-200">{profile.sourceRoot}</span>{" "}
      with <span className="text-zinc-800 dark:text-zinc-200">{profile.apiUrl}</span>. Nothing
      changes on the server until you push.
    </EmptyState>
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

  const changeCount = current.counts.upload + current.counts.update + current.counts.delete;

  return (
    <>
      <div className="shrink-0 border-b lw-divider px-5 py-2.5">
        <p className="lw-caption truncate" title={`${current.sourceRoot} → ${profile.apiUrl}`}>
          {current.sourceRoot} → {profile.apiUrl}
        </p>
        <div className="mt-2 flex items-center gap-2">
          {showRunState ? (
            <fieldset aria-label="Run filter" className="lw-seg">
              {RUN_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={runFilter === value}
                  onClick={() => setRunFilter(value)}
                  className={`lw-seg-item ${value === "failed" && runCounts.failed > 0 ? "text-red-600 dark:text-red-400" : ""}`}
                >
                  {label}
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">
                    {runCounts[value].toLocaleString()}
                  </span>
                </button>
              ))}
            </fieldset>
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
                  title={`Show only what to ${CHANGE_LABEL[action]}`}
                  className={`lw-chip pr-3 transition-[background-color,box-shadow,opacity] duration-150 ${
                    actionFilter.size > 0 && !actionFilter.has(action) ? "opacity-50" : ""
                  } ${actionFilter.has(action) ? "ring-1 ring-zinc-900/20 dark:ring-white/25" : ""}`}
                >
                  <span className={`size-2 rounded-full ${ACTION_DOT[action]}`} aria-hidden />
                  {current.counts[action].toLocaleString()} to {CHANGE_LABEL[action]}
                  {action === "delete" ? null : (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {formatBytes(bytesByAction[action])}
                    </span>
                  )}
                </button>
              ) : (
                <span key={action} data-plan-count={action} data-count={0} hidden />
              ),
            )
          )}
          <label className="relative ml-auto w-60 max-w-[40%]">
            <span className="sr-only">Filter plan paths</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-400"
              aria-hidden
            />
            <input
              id={PLAN_FILTER_INPUT_ID}
              className="lw-input px-8"
              value={plan.filter}
              onChange={(event) => plan.setFilter(event.target.value)}
              placeholder="Filter paths"
            />
            <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          </label>
        </div>
      </div>
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
        <div className="lw-caption flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
          <span data-plan-count="keep" data-count={current.counts.keep}>
            {current.counts.keep.toLocaleString()} unchanged
          </span>
          {current.skipped > 0 ? (
            <button
              type="button"
              className="underline decoration-zinc-300 underline-offset-2 hover:text-zinc-900 dark:decoration-zinc-600 dark:hover:text-zinc-100"
              aria-expanded={showSkipped}
              onClick={() => setShowSkipped((open) => !open)}
            >
              {current.skipped.toLocaleString()} skipped · {showSkipped ? "hide" : "why?"}
            </button>
          ) : null}
        </div>
        {showSkipped ? (
          <ul className="px-5 pb-28 text-xs text-zinc-500 dark:text-zinc-400">
            {current.skippedEntries.map((entry) => (
              <li key={entry.path} className="flex gap-3 py-0.5">
                <span className="truncate text-zinc-800 dark:text-zinc-200">{entry.path}</span>
                <span className="shrink-0">{entry.reason}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="h-24" aria-hidden />
        )}
      </div>
    </>
  );
}
