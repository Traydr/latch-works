import {
  ArrowUpCircle,
  ChevronDown,
  CircleCheck,
  Footprints,
  ListChecks,
  Play,
  Plus,
  Stethoscope,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { AlertBanner } from "../components/AlertBanner";
import { DoctorCheckList } from "../components/DoctorCheckList";
import { ProfileSelect } from "../components/ProfileSelect";
import type { LockstepController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { PlanLegend, PlanList, profileFieldList, TokenInput } from "./pieces";
import {
  formatBytes,
  formatDuration,
  ProportionBar,
  ReservedBar,
  Stat,
  SyncLine,
  useNow,
} from "./shared";

const STAGES = [
  { label: "Profile", icon: CircleCheck },
  { label: "Plan", icon: Play },
  { label: "Review", icon: ListChecks },
  { label: "Push", icon: ArrowUpCircle },
  { label: "Prune", icon: Trash2 },
] as const;

export function Layout5({ ctrl }: { ctrl: LockstepController }) {
  const {
    screen,
    setScreen,
    settings,
    activeProfile,
    running,
    error,
    handleDoctor,
    handlePlan,
    handlePush,
    handlePrune,
  } = ctrl;
  const [runExpanded, setRunExpanded] = useState(false);
  const showProfile = screen === "profile";
  const showWorkspace = !showProfile && !!activeProfile;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Minimal top bar. */}
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
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-6 px-1"
            onClick={() => setScreen("profile")}
            title="Add profile"
          >
            <Plus className="size-3" aria-hidden />
          </button>
          <div className="h-3 w-px bg-zinc-300 dark:bg-zinc-700" />
          <MiniAction
            icon={Stethoscope}
            disabled={running || !activeProfile}
            onClick={handleDoctor}
          />
          <MiniAction icon={Play} disabled={running || !activeProfile} onClick={handlePlan} />
          <MiniAction
            icon={ArrowUpCircle}
            disabled={running || !activeProfile}
            onClick={handlePush}
          />
          <MiniAction
            icon={Trash2}
            danger
            disabled={running || !activeProfile}
            onClick={handlePrune}
          />
        </div>
      </header>

      {/* Compact breadcrumb pipeline — centered, calm. */}
      {showWorkspace ? (
        <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/50 px-4 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/20">
          <div className="mx-auto flex max-w-xl items-center justify-center gap-1">
            {STAGES.map((stage, index) => {
              const done = stageDone(index, ctrl);
              const active = stageActive(index, ctrl);
              return (
                <div key={stage.label} className="flex items-center gap-1">
                  <span
                    className={`flex size-3.5 items-center justify-center rounded-full border text-[8px] ${active ? "border-violet-400 bg-violet-500/30 text-violet-100 ls-pulse" : done ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : "border-zinc-600 bg-zinc-800/60 text-zinc-500"}`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  <span
                    className={`hidden text-[10px] sm:inline ${active ? "text-violet-700 dark:text-violet-200" : done ? "text-emerald-600 dark:text-emerald-300" : "text-zinc-500"}`}
                  >
                    {stage.label}
                  </span>
                  {index < STAGES.length - 1 ? (
                    <ChevronDown className="size-2.5 -rotate-90 text-zinc-400" aria-hidden />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="shrink-0 px-3 pt-2">
          <AlertBanner message={error} />
        </div>
      ) : null}

      {showProfile ? (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-xl">
            <ProfileSetupView
              form={ctrl.profileForm}
              onCancel={() => setScreen("dashboard")}
              onChange={(patch) => ctrl.setProfileForm((c) => ({ ...c, ...patch }))}
              onPickFolder={() => void ctrl.handlePickFolder()}
              onSubmit={(e) => void ctrl.handleCreateProfile(e)}
            />
          </div>
        </div>
      ) : null}

      {!showProfile && !activeProfile ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Welcome5 onCreate={() => setScreen("profile")} />
        </div>
      ) : null}

      {/* Centered content — narrow focused column. */}
      {showWorkspace ? (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-4 pb-32">
            <section className="ls-surface p-3">
              <h2 className="text-sm font-semibold tracking-tight">{activeProfile?.name}</h2>
              <div className="mt-2 grid grid-cols-1 gap-y-1.5">
                {activeProfile
                  ? profileFieldList(activeProfile).map((f) => (
                      <div key={f.label} className="flex min-w-0 items-center gap-2">
                        <span className="ls-label w-16 shrink-0">{f.label}</span>
                        <span
                          className={`truncate ls-mono text-xs ${f.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                          title={f.value}
                        >
                          {f.value}
                        </span>
                      </div>
                    ))
                  : null}
              </div>
              {activeProfile ? (
                <div className="mt-3">
                  <TokenInput
                    value={ctrl.sessionToken}
                    onChange={ctrl.setSessionToken}
                    profile={activeProfile}
                  />
                </div>
              ) : null}
            </section>
            {ctrl.plan ? (
              <section className="ls-surface p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold tracking-tight">Latest plan</h3>
                  <button type="button" className="ls-btn" onClick={() => setScreen("plan")}>
                    Review
                  </button>
                </div>
                <div className="mt-2">
                  <ProportionBar counts={ctrl.plan.counts} />
                </div>
                <div className="mt-2">
                  <PlanLegend counts={ctrl.plan.counts} />
                </div>
                <p className="mt-2 ls-mono text-[10px] text-zinc-500">
                  {ctrl.plan.totalFiles.toLocaleString()} files ·{" "}
                  {formatBytes(ctrl.plan.totalBytes)} · {ctrl.plan.skipped} skipped
                </p>
              </section>
            ) : null}
            {ctrl.doctorResult ? (
              <section className="ls-surface p-3">
                <p className="ls-label mb-1">doctor</p>
                <DoctorCheckList result={ctrl.doctorResult} />
              </section>
            ) : null}
            {ctrl.screen === "plan" && ctrl.plan ? (
              <section className="ls-surface h-72 p-3">
                <h3 className="mb-2 text-sm font-semibold tracking-tight">Review changes</h3>
                <PlanList ctrl={ctrl} className="h-full" />
              </section>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Floating progress card — docked bottom-center, always present. */}
      {showWorkspace ? (
        <FloatingRun5
          ctrl={ctrl}
          expanded={runExpanded}
          onToggle={() => setRunExpanded((c) => !c)}
        />
      ) : null}
    </div>
  );
}

function MiniAction({
  icon: Icon,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Play;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className={`ls-btn ls-btn-ghost h-6 px-1.5 ${danger ? "text-red-500 dark:text-red-400" : ""}`}
    >
      <Icon className="size-3" aria-hidden />
    </button>
  );
}

function FloatingRun5({
  ctrl,
  expanded,
  onToggle,
}: {
  ctrl: LockstepController;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { runProgress, running, runLabel, logs, handleCancel } = ctrl;
  const now = useNow(running);
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
  const elapsed = runProgress.startedAt ? (runProgress.endedAt ?? now) - runProgress.startedAt : 0;
  const idle = runProgress.phase === "idle" && !running;
  const counter =
    runProgress.itemTotal > 0 ? `${runProgress.itemCurrent}/${runProgress.itemTotal}` : null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-3">
      <div className="ls-surface pointer-events-auto w-full max-w-xl p-3 shadow-xl">
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${running ? "bg-violet-400 ls-pulse" : idle ? "bg-zinc-600" : runProgress.phase === "done" ? "bg-emerald-400" : "bg-red-400"}`}
            aria-hidden
          />
          <span className="ls-label">activity</span>
          <ReservedBar
            percent={idle ? null : percent}
            indeterminate={idle ? false : indeterminate}
            tone={tone}
            className="ml-1 flex-1"
          />
          <span className="w-14 shrink-0 text-right ls-mono text-[10px] tabular-nums text-zinc-500">
            {formatDuration(elapsed)}
          </span>
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-5 px-1"
            onClick={onToggle}
            title="Expand"
          >
            <ChevronDown
              className={`size-3 transition ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          {running ? (
            <button
              type="button"
              className="ls-btn ls-btn-ghost h-5 px-1 text-[11px] text-red-500"
              onClick={() => void handleCancel()}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <div className="mt-1.5">
          <SyncLine
            action={runProgress.currentAction}
            path={runProgress.currentPath ?? runLabel}
            counter={counter}
            idle={idle}
            running={running}
          />
        </div>
        {expanded ? (
          <div className="mt-2">
            <div className="grid grid-cols-4 gap-2">
              <Stat label="files" value={runProgress.scanFilesFound.toLocaleString()} />
              <Stat label="hashed" value={formatBytes(runProgress.bytesHashed)} />
              <Stat label="pushed" value={runProgress.pushed} tone="text-emerald-400" />
              <Stat
                label="failed"
                value={runProgress.failed}
                tone={runProgress.failed ? "text-red-400" : "text-zinc-400"}
              />
            </div>
            <div className="ls-surface-2 mt-1.5 h-24 overflow-auto p-2 ls-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
              {logs.length > 0 ? logs.slice(-60).join("\n") : "Waiting..."}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function stageDone(index: number, ctrl: LockstepController): boolean {
  if (index === 0) return !!ctrl.activeProfile;
  if (index === 1) return !!ctrl.plan;
  return false;
}
function stageActive(index: number, ctrl: LockstepController): boolean {
  if (index === 0) return !ctrl.activeProfile || ctrl.screen === "profile";
  if (index === 2) return ctrl.screen === "plan";
  if (ctrl.running) {
    if (index === 1 && ctrl.runProgress.action === "plan") return true;
    if (index === 3 && ctrl.runProgress.action === "push") return true;
    if (index === 4 && ctrl.runProgress.action === "prune") return true;
  }
  return false;
}

function Welcome5({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        A calm, focused column. The breadcrumb shows your place in the flow; a floating card at the
        bottom tracks live progress without intruding on the content above.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
