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

type StageKey = "profile" | "plan" | "review" | "push" | "prune";
const STAGES: Array<{ key: StageKey; label: string; icon: typeof Play }> = [
  { key: "profile", label: "Profile", icon: CircleCheck },
  { key: "plan", label: "Plan", icon: Play },
  { key: "review", label: "Review", icon: ListChecks },
  { key: "push", label: "Push", icon: ArrowUpCircle },
  { key: "prune", label: "Prune", icon: Trash2 },
];

export function Layout4({ ctrl }: { ctrl: LockstepController }) {
  const { screen, setScreen, settings, activeProfile, running, error, handleDoctor } = ctrl;
  const [logOpen, setLogOpen] = useState(false);
  const showProfileForm = screen === "profile";

  const activeStage: StageKey =
    screen === "profile"
      ? "profile"
      : screen === "plan"
        ? "review"
        : running
          ? ctrl.runProgress.action === "plan"
            ? "plan"
            : ctrl.runProgress.action === "push"
              ? "push"
              : ctrl.runProgress.action === "prune"
                ? "prune"
                : "profile"
          : "profile";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Pipeline as header tabs — signature. */}
      <header className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
        <Footprints className="size-3.5 shrink-0 text-violet-500" aria-hidden />
        {settings && settings.profiles.length > 0 ? (
          <ProfileSelect
            profiles={settings.profiles}
            value={settings.activeProfileId ?? ""}
            onChange={(id) => void ctrl.handleProfileChange(id)}
          />
        ) : null}
        <div className="mx-1 flex flex-1 items-center">
          {STAGES.map((stage, index) => {
            const done = stageDone(index, ctrl);
            const active = activeStage === stage.key;
            const disabled = stageDisabled(index, ctrl);
            return (
              <div key={stage.key} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => stageClick(index, ctrl, setScreen)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition disabled:opacity-40 ${active ? "bg-violet-500/15 text-violet-700 dark:text-violet-200" : done ? "text-emerald-600 dark:text-emerald-300" : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"}`}
                >
                  <span
                    className={`flex size-4 items-center justify-center rounded-full border text-[9px] ${active ? "border-violet-400 bg-violet-500/30 text-violet-100 ls-pulse" : done ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : "border-zinc-600 bg-zinc-800/60 text-zinc-500"}`}
                  >
                    {done ? "✓" : index + 1}
                  </span>
                  <stage.icon className="size-3.5" aria-hidden />
                  <span className="whitespace-nowrap">{stage.label}</span>
                </button>
                {index < STAGES.length - 1 ? (
                  <div
                    className={`mx-0.5 h-px min-w-4 flex-1 ${done ? "bg-emerald-500/40" : "bg-zinc-300 dark:bg-zinc-700"}`}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-6 px-1"
            onClick={() => setScreen("profile")}
            title="Add profile"
          >
            <Plus className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-6 px-1.5"
            disabled={running || !activeProfile}
            onClick={() => void handleDoctor()}
            title="Doctor"
          >
            <Stethoscope className="size-3" aria-hidden />
          </button>
        </div>
      </header>

      {/* Reserved run strip — directly under header, always present. */}
      {activeProfile && !showProfileForm ? (
        <RunStrip4 ctrl={ctrl} logOpen={logOpen} onToggleLog={() => setLogOpen((c) => !c)} />
      ) : null}

      {error ? (
        <div className="shrink-0 px-3 pt-2">
          <AlertBanner message={error} />
        </div>
      ) : null}

      {showProfileForm ? (
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

      {!showProfileForm && !activeProfile ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <Welcome4 onCreate={() => setScreen("profile")} />
        </div>
      ) : null}

      {!showProfileForm && activeProfile ? (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
            <section className="ls-surface p-3">
              <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {profileFieldList(activeProfile).map((f) => (
                  <div key={f.label} className="flex min-w-0 items-center gap-2">
                    <span className="ls-label w-14 shrink-0">{f.label}</span>
                    <span
                      className={`truncate ls-mono text-xs ${f.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                      title={f.value}
                    >
                      {f.value}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <TokenInput
                  value={ctrl.sessionToken}
                  onChange={ctrl.setSessionToken}
                  profile={activeProfile}
                />
              </div>
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
    </div>
  );
}

function RunStrip4({
  ctrl,
  logOpen,
  onToggleLog,
}: {
  ctrl: LockstepController;
  logOpen: boolean;
  onToggleLog: () => void;
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
    <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/80 px-4 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/50">
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
        <button
          type="button"
          className="ls-btn ls-btn-ghost h-5 px-1"
          onClick={onToggleLog}
          title="Toggle log"
        >
          <ChevronDown className={`size-3 transition ${logOpen ? "rotate-180" : ""}`} aria-hidden />
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
      {logOpen ? (
        <div className="mx-auto mt-1 max-w-2xl">
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
          <div className="ls-surface-2 mt-1 h-24 overflow-auto p-2 ls-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
            {logs.length > 0 ? logs.slice(-60).join("\n") : "Waiting..."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function stageDone(index: number, ctrl: LockstepController): boolean {
  if (index === 0) return !!ctrl.activeProfile;
  if (index === 1) return !!ctrl.plan;
  return false;
}
function stageDisabled(index: number, ctrl: LockstepController): boolean {
  if (index === 0) return false;
  if (!ctrl.activeProfile) return true;
  if (index === 2) return !ctrl.plan;
  return false;
}
function stageClick(
  index: number,
  ctrl: LockstepController,
  setScreen: (s: "dashboard" | "plan" | "profile" | "run") => void,
): void {
  if (index === 0) setScreen("profile");
  else if (index === 2 && ctrl.plan) setScreen("plan");
}

function Welcome4({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        The pipeline is the header — navigate stages by clicking the tabs. Progress streams in a
        reserved strip directly beneath, never displacing your content.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
