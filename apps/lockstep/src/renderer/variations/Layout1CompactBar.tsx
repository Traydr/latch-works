import {
  ArrowUpCircle,
  ChevronDown,
  Footprints,
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

const STAGES = ["Profile", "Plan", "Review", "Push", "Prune"] as const;

export function Layout1({ ctrl }: { ctrl: LockstepController }) {
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

  const [planExpanded, setPlanExpanded] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);
  const showProfile = screen === "profile";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Thin command bar — everything in one row. */}
      <header className="flex shrink-0 items-center gap-1.5 border-b border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800">
        <Footprints className="size-3.5 shrink-0 text-violet-500" aria-hidden />
        <span className="shrink-0 text-xs font-semibold tracking-tight">Lockstep</span>
        {settings && settings.profiles.length > 0 ? (
          <ProfileSelect
            profiles={settings.profiles}
            value={settings.activeProfileId ?? ""}
            onChange={(id) => void ctrl.handleProfileChange(id)}
          />
        ) : null}
        {/* Condensed pipeline dots — inline in the bar. */}
        <div className="ml-1 flex items-center gap-0.5">
          {STAGES.map((label, index) => {
            const done = stageDone(index, ctrl);
            const active = stageActive(index, ctrl);
            return (
              <span
                key={label}
                title={label}
                className={`size-1.5 rounded-full ${active ? "bg-violet-400 ls-pulse" : done ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-700"}`}
              />
            );
          })}
        </div>
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
          <Welcome1 onCreate={() => setScreen("profile")} />
        </div>
      ) : null}

      {!showProfile && activeProfile ? (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-2.5 p-4">
            <section className="ls-surface p-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-xs font-semibold tracking-tight">{activeProfile.name}</span>
                {profileFieldList(activeProfile).map((f) => (
                  <span key={f.label} className="inline-flex min-w-0 items-center gap-1">
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
              <div className="mt-2">
                <TokenInput
                  value={ctrl.sessionToken}
                  onChange={ctrl.setSessionToken}
                  profile={activeProfile}
                />
              </div>
            </section>

            {ctrl.plan ? (
              <section className="ls-surface p-3">
                <button
                  type="button"
                  onClick={() => setPlanExpanded((c) => !c)}
                  className="flex w-full items-center gap-2"
                >
                  <ChevronDown
                    className={`size-3.5 shrink-0 text-zinc-400 transition ${planExpanded ? "" : "-rotate-90"}`}
                    aria-hidden
                  />
                  <span className="ls-label">latest plan</span>
                  <div className="min-w-0 flex-1">
                    <ProportionBar counts={ctrl.plan.counts} />
                  </div>
                  <PlanLegend counts={ctrl.plan.counts} />
                </button>
                <p className="mt-1.5 ls-mono text-[10px] text-zinc-500">
                  {ctrl.plan.totalFiles.toLocaleString()} files ·{" "}
                  {formatBytes(ctrl.plan.totalBytes)} · {ctrl.plan.skipped} skipped
                </p>
                {planExpanded ? (
                  <div className="mt-2 h-56">
                    <PlanList ctrl={ctrl} className="h-full" />
                  </div>
                ) : null}
              </section>
            ) : null}

            {ctrl.doctorResult ? (
              <section className="ls-surface p-3">
                <p className="ls-label mb-1">doctor</p>
                <DoctorCheckList result={ctrl.doctorResult} />
              </section>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Reserved run strip — slim, expandable. Always present. */}
      {activeProfile && !showProfile ? (
        <RunStrip1 ctrl={ctrl} expanded={runExpanded} onToggle={() => setRunExpanded((c) => !c)} />
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

function RunStrip1({
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
    <div className="shrink-0 border-t border-zinc-200 bg-zinc-50/90 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/70">
      <div className="mx-auto flex max-w-2xl items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${running ? "bg-violet-400 ls-pulse" : idle ? "bg-zinc-600" : runProgress.phase === "done" ? "bg-emerald-400" : "bg-red-400"}`}
          aria-hidden
        />
        <ReservedBar
          percent={idle ? null : percent}
          indeterminate={idle ? false : indeterminate}
          tone={tone}
          className="flex-1"
        />
        <span className="w-16 shrink-0 text-right ls-mono text-[10px] tabular-nums text-zinc-500">
          {formatDuration(elapsed)}
        </span>
        <button type="button" className="ls-btn ls-btn-ghost h-5 px-1" onClick={onToggle}>
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
      <div className="mx-auto max-w-2xl">
        <SyncLine
          action={runProgress.currentAction}
          path={runProgress.currentPath ?? runLabel}
          counter={counter}
          idle={idle}
          running={running}
        />
      </div>
      {expanded ? (
        <div className="mx-auto mt-1.5 max-w-2xl">
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
          <div className="ls-surface-2 mt-1.5 h-28 overflow-auto p-2 ls-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
            {logs.length > 0 ? logs.slice(-60).join("\n") : "Waiting..."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Welcome1({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Minimal by design: one bar, one surface, one strip. The pipeline dots show where you are;
        the bottom strip shows live progress.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
