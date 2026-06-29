import {
  ArrowUpCircle,
  CircleCheck,
  Footprints,
  ListChecks,
  Play,
  Plus,
  Stethoscope,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { LockstepController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { AlertBanner } from "./AlertBanner";
import { DoctorCheckList } from "./DoctorCheckList";
import { ProfileSelect } from "./ProfileSelect";
import { PlanLegend, PlanList, profileFieldList, TokenInput } from "./planPieces";
import {
  formatBytes,
  formatDuration,
  ProportionBar,
  ReservedBar,
  Stat,
  SyncLine,
  useNow,
} from "./syncPrimitives";
import { isElapsedClockActive } from "../lib/run-lifecycle";

const STAGES = [
  { label: "Profile", icon: CircleCheck },
  { label: "Plan", icon: Play },
  { label: "Review", icon: ListChecks },
  { label: "Push", icon: ArrowUpCircle },
  { label: "Prune", icon: Trash2 },
] as const;

type Tab = "dashboard" | "plan" | "log";

export function AppLayout({ ctrl }: { ctrl: LockstepController }) {
  const { screen, setScreen, settings, activeProfile, error } = ctrl;
  const [tab, setTab] = useState<Tab>("dashboard");
  const showProfile = screen === "profile";
  const showWorkspace = !showProfile && !!activeProfile;

  // Sync the plan tab when the controller transitions to the plan screen
  // (happens after handlePlan completes or when the Review pipeline stage is clicked).
  useEffect(() => {
    if (screen === "plan") {
      setTab("plan");
    }
  }, [screen]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <Footprints className="size-3.5 text-violet-500" aria-hidden />
        <span className="text-xs font-semibold tracking-tight">Lockstep</span>
        {settings && settings.profiles.length > 0 ? (
          <ProfileSelect
            profiles={settings.profiles}
            value={settings.activeProfileId ?? ""}
            onChange={(id) => void ctrl.handleProfileChange(id)}
          />
        ) : null}
        <button
          type="button"
          className="ls-btn ls-btn-ghost ml-auto h-6 px-1"
          onClick={() => setScreen("profile")}
          title="Add profile"
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </header>

      {error ? (
        <div className="shrink-0 px-3 pt-2">
          <AlertBanner message={error} />
        </div>
      ) : null}

      {showProfile ? (
        <div className="flex-1 overflow-y-auto p-4">
          <ProfileSetupView
            form={ctrl.profileForm}
            onCancel={() => setScreen("dashboard")}
            onChange={(patch) => ctrl.setProfileForm((c) => ({ ...c, ...patch }))}
            onPickFolder={() => void ctrl.handlePickFolder()}
            onSubmit={(e) => void ctrl.handleCreateProfile(e)}
          />
        </div>
      ) : null}

      {!showProfile && !activeProfile ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Welcome onCreate={() => setScreen("profile")} />
        </div>
      ) : null}

      {showWorkspace ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
            <TabBtn
              label="Dashboard"
              active={tab === "dashboard"}
              onClick={() => setTab("dashboard")}
            />
            <TabBtn
              label="Plan"
              active={tab === "plan"}
              disabled={!ctrl.plan}
              onClick={() => {
                if (ctrl.plan) {
                  ctrl.markReviewVisited();
                  setTab("plan");
                }
              }}
            />
            <TabBtn label="Log" active={tab === "log"} onClick={() => setTab("log")} />
            {ctrl.plan ? (
              <span className="ml-auto">
                <PlanLegend counts={ctrl.plan.counts} />
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "dashboard" && activeProfile ? (
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                <section className="ls-surface p-3">
                  <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {profileFieldList(activeProfile).map((f) => (
                      <span key={f.label} className="inline-flex min-w-0 items-center gap-1.5">
                        <span className="ls-label">{f.label}</span>
                        <span
                          className={`truncate ls-mono text-xs ${f.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                          title={f.value}
                        >
                          {f.value}
                        </span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-3">
                    <TokenInput
                      value={ctrl.sessionToken}
                      onChange={ctrl.setSessionToken}
                      profile={activeProfile}
                    />
                  </div>
                  {ctrl.plan ? (
                    <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                      <div className="flex items-center justify-between">
                        <span className="ls-label">latest plan</span>
                      </div>
                      <div className="mt-1.5">
                        <ProportionBar counts={ctrl.plan.counts} />
                      </div>
                      <div className="mt-2">
                        <PlanLegend counts={ctrl.plan.counts} />
                      </div>
                      <p className="mt-2 ls-mono text-[10px] text-zinc-500">
                        {ctrl.plan.totalFiles.toLocaleString()} files ·{" "}
                        {formatBytes(ctrl.plan.totalBytes)} · {ctrl.plan.skipped} skipped
                      </p>
                    </div>
                  ) : null}
                  {ctrl.doctorResult ? (
                    <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                      <p className="ls-label mb-1">doctor</p>
                      <div className="max-h-32 overflow-auto">
                        <DoctorCheckList result={ctrl.doctorResult} />
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}
            {tab === "plan" && ctrl.plan ? (
              <section className="ls-surface mx-auto flex h-full max-w-2xl flex-col p-3">
                <h2 className="mb-2 text-sm font-semibold tracking-tight">Review changes</h2>
                <PlanList ctrl={ctrl} className="min-h-0 flex-1" />
              </section>
            ) : null}
            {tab === "log" ? <LogPanel ctrl={ctrl} /> : null}
          </div>
        </div>
      ) : null}

      {showWorkspace ? <CommandDock ctrl={ctrl} /> : null}
    </div>
  );
}

function TabBtn({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded px-2 py-1 text-xs transition disabled:opacity-40 ${active ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800/60"}`}
    >
      {label}
    </button>
  );
}

function LogPanel({ ctrl }: { ctrl: LockstepController }) {
  const { logs, running } = ctrl;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && logs.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);
  return (
    <section className="ls-surface mx-auto flex h-full max-w-2xl flex-col p-3">
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight">Run log</h2>
        <span className="ls-mono text-[10px] text-zinc-500">
          {logs.length} {running ? "· live" : "lines"}
        </span>
      </div>
      <div
        ref={ref}
        className="ls-surface-2 min-h-0 flex-1 overflow-auto p-3 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400"
      >
        {logs.length > 0
          ? logs.join("\n")
          : "No log output yet. Run Plan, Push, or Prune to see activity."}
      </div>
    </section>
  );
}

function CommandDock({ ctrl }: { ctrl: LockstepController }) {
  const {
    activeProfile,
    plan,
    running,
    runProgress,
    pipelineProgress,
    handleDoctor,
    handlePlan,
    handlePush,
    handlePrune,
    setScreen,
  } = ctrl;
  const clockActive = isElapsedClockActive(
    running,
    runProgress.startedAt,
    runProgress.endedAt,
  );
  const now = useNow(clockActive);
  const hasProfile = !!activeProfile;
  const hasPlan = !!plan;
  const activeAction = runProgress.action;

  const states = [
    {
      done: hasProfile,
      active: !hasProfile || ctrl.screen === "profile",
      disabled: false,
      onClick: () => setScreen("profile"),
    },
    {
      done: hasPlan,
      active: running && activeAction === "plan",
      disabled: running || !hasProfile,
      onClick: () => void handlePlan(),
    },
    {
      done: pipelineProgress.reviewed,
      active: ctrl.screen === "plan" && !running,
      disabled: !hasPlan,
      onClick: () => plan && setScreen("plan"),
    },
    {
      done: pipelineProgress.pushCompleted,
      active: running && activeAction === "push",
      disabled: running || !hasProfile,
      onClick: () => void handlePush(),
    },
    {
      done: pipelineProgress.pruneCompleted,
      active: running && activeAction === "prune",
      disabled: running || !hasProfile,
      onClick: () => void handlePrune(),
    },
  ];

  const percent =
    runProgress.phase === "done"
      ? 1
      : runProgress.itemTotal > 0
        ? runProgress.itemCurrent / runProgress.itemTotal
        : null;
  const indeterminate = percent == null && running && runProgress.phase !== "idle";
  const tone =
    runProgress.phase === "error" || runProgress.phase === "cancelled"
      ? "red"
      : runProgress.phase === "done"
        ? "emerald"
        : "violet";
  const showFill = running || runProgress.phase !== "idle";
  const elapsed = runProgress.startedAt ? (runProgress.endedAt ?? now) - runProgress.startedAt : 0;
  const idle = runProgress.phase === "idle" && !running;
  const counter =
    runProgress.itemTotal > 0 ? `${runProgress.itemCurrent}/${runProgress.itemTotal}` : null;

  return (
    <div className="flex h-44 shrink-0 flex-col border-t-2 border-violet-500/30 bg-zinc-50/95 dark:bg-zinc-900/80">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        {STAGES.map((stage, index) => {
          const state = states[index];
          return (
            <button
              key={stage.label}
              type="button"
              disabled={state.disabled}
              onClick={state.onClick}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition disabled:opacity-40 ${state.active ? "bg-violet-500/15 text-violet-700 dark:text-violet-200" : state.done ? "text-emerald-600 dark:text-emerald-300" : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"}`}
            >
              <span
                className={`flex size-4 items-center justify-center rounded-full border text-[9px] ${state.active ? "border-violet-400 bg-violet-500/30 text-violet-100 ls-pulse" : state.done ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : "border-zinc-600 bg-zinc-800/60 text-zinc-500"}`}
              >
                {state.done ? "✓" : index + 1}
              </span>
              <stage.icon className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">{stage.label}</span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button
              type="button"
              className="ls-btn ls-btn-danger h-6"
              onClick={() => void ctrl.handleCancel()}
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            className="ls-btn h-6"
            disabled={running || !hasProfile}
            onClick={() => void handleDoctor()}
          >
            <Stethoscope className="size-3" aria-hidden />{" "}
            <span className="hidden md:inline">Doctor</span>
          </button>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1">
        <ReservedBar
          percent={idle ? null : percent}
          indeterminate={idle ? false : indeterminate}
          tone={tone}
          className="flex-1"
        />
        <span className="w-20 shrink-0 text-right ls-mono text-[10px] tabular-nums text-zinc-500">
          {showFill && runProgress.itemTotal > 0 ? counter : showFill ? runProgress.phase : "ready"}
        </span>
        <span className="w-14 shrink-0 text-right ls-mono text-[10px] tabular-nums text-zinc-500">
          {formatDuration(elapsed)}
        </span>
      </div>
      <div className="shrink-0 px-3">
        <SyncLine
          action={runProgress.currentAction}
          path={runProgress.currentPath ?? ctrl.runLabel}
          counter={counter}
          idle={idle}
          running={running}
        />
      </div>
      <div className="grid shrink-0 grid-cols-4 gap-2 px-3 py-1.5">
        <Stat label="files" value={runProgress.scanFilesFound.toLocaleString()} />
        <Stat label="hashed" value={formatBytes(runProgress.bytesHashed)} />
        <Stat label="pushed" value={runProgress.pushed} tone="text-emerald-400" />
        <Stat
          label="failed"
          value={runProgress.failed}
          tone={runProgress.failed ? "text-red-400" : "text-zinc-400"}
        />
      </div>
    </div>
  );
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Content on top, command below. The pipeline and live progress share a single docked surface
        — everything you need to act is in one place.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
