import {
  ArrowUpCircle,
  ChevronDown,
  ChevronRight,
  Footprints,
  Play,
  Plus,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

import { AlertBanner } from "../components/AlertBanner";
import { DoctorCheckList } from "../components/DoctorCheckList";
import { ProfileSelect } from "../components/ProfileSelect";
import type { LockstepController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { PlanLegend, PlanList, profileFieldList, TokenInput } from "./pieces";
import {
  ActionChip,
  formatBytes,
  formatDuration,
  ProgressBar,
  ProportionBar,
  Stat,
  useNow,
} from "./shared";

export function Layout5({ ctrl }: { ctrl: LockstepController }) {
  const {
    screen,
    setScreen,
    settings,
    activeProfile,
    running,
    plan,
    error,
    handleDoctor,
    handlePlan,
    handlePush,
    handlePrune,
  } = ctrl;

  const [planExpanded, setPlanExpanded] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);

  const showProfile = screen === "profile";
  const showStrip = running || ctrl.runProgress.phase !== "idle";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md border border-violet-400/50 bg-violet-500/15 text-violet-600 dark:text-violet-300">
            <Footprints className="size-3.5" aria-hidden />
          </div>
          <span className="text-xs font-semibold tracking-tight">Lockstep</span>
        </div>
        {settings && settings.profiles.length > 0 ? (
          <ProfileSelect
            profiles={settings.profiles}
            value={settings.activeProfileId ?? ""}
            onChange={(id) => void ctrl.handleProfileChange(id)}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-7"
            onClick={() => setScreen("profile")}
            title="Add profile"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
          <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <GhostAction
            icon={Stethoscope}
            label="Doctor"
            disabled={running || !activeProfile}
            onClick={handleDoctor}
          />
          <GhostAction
            icon={Play}
            label="Plan"
            disabled={running || !activeProfile}
            onClick={handlePlan}
          />
          <GhostAction
            icon={ArrowUpCircle}
            label="Push"
            disabled={running || !activeProfile}
            onClick={handlePush}
          />
          <GhostAction
            icon={Trash2}
            label="Prune"
            danger
            disabled={running || !activeProfile}
            onClick={handlePrune}
          />
        </div>
      </header>

      {showStrip ? (
        <ProgressStrip5
          ctrl={ctrl}
          expanded={logExpanded}
          onToggle={() => setLogExpanded((current) => !current)}
        />
      ) : null}

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
          {error ? <AlertBanner message={error} /> : null}

          {showProfile ? (
            <ProfileSetupView
              form={ctrl.profileForm}
              onCancel={() => setScreen("dashboard")}
              onChange={(patch) => ctrl.setProfileForm((current) => ({ ...current, ...patch }))}
              onPickFolder={() => void ctrl.handlePickFolder()}
              onSubmit={(event) => void ctrl.handleCreateProfile(event)}
            />
          ) : null}

          {!showProfile && !activeProfile ? (
            <Welcome5 onCreate={() => setScreen("profile")} />
          ) : null}

          {!showProfile && activeProfile ? (
            <section className="ls-surface p-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
                <span className="ls-label">dashboard</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                {profileFieldList(activeProfile).map((field) => (
                  <span key={field.label} className="inline-flex items-center gap-1.5 min-w-0">
                    <span className="ls-label">{field.label}</span>
                    <span
                      className={`truncate ls-mono text-xs ${field.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                      title={field.value}
                    >
                      {field.value}
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

              {plan ? (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setPlanExpanded((current) => !current)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    {planExpanded ? (
                      <ChevronDown className="size-3.5 text-zinc-400" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5 text-zinc-400" aria-hidden />
                    )}
                    <span className="ls-label">latest plan</span>
                    <div className="min-w-0 flex-1">
                      <ProportionBar counts={plan.counts} />
                    </div>
                    <PlanLegend counts={plan.counts} />
                  </button>
                  <p className="mt-1.5 ls-mono text-[10px] text-zinc-500">
                    {plan.totalFiles.toLocaleString()} files · {formatBytes(plan.totalBytes)} ·{" "}
                    {plan.skipped} skipped
                  </p>
                  {planExpanded ? (
                    <div className="mt-2 h-72">
                      <PlanList ctrl={ctrl} className="h-full" />
                    </div>
                  ) : null}
                </div>
              ) : null}

              {ctrl.doctorResult ? (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <p className="ls-label mb-1">doctor</p>
                  <DoctorCheckList result={ctrl.doctorResult} />
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function GhostAction({
  icon: Icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className={`ls-btn ls-btn-ghost h-7 ${danger ? "text-red-500 hover:text-red-400 dark:text-red-400" : ""}`}
      title={label}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function ProgressStrip5({
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
  const pctLabel = percent == null ? "—" : `${Math.round(percent * 100)}%`;

  return (
    <div className="border-b border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-1.5">
        <span
          className={`size-1.5 shrink-0 rounded-full ${running ? "bg-violet-400 ls-pulse" : runProgress.phase === "done" ? "bg-emerald-400" : "bg-red-400"}`}
          aria-hidden
        />
        {runProgress.currentAction ? <ActionChip action={runProgress.currentAction} /> : null}
        <span
          className="truncate ls-mono text-[11px] text-zinc-600 dark:text-zinc-300"
          title={runProgress.currentPath ?? runLabel}
        >
          {runProgress.currentPath ?? runLabel ?? "Working..."}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="ls-mono text-[10px] tabular-nums text-zinc-400">
            {runProgress.itemTotal > 0 ? `${runProgress.itemCurrent}/${runProgress.itemTotal}` : ""}{" "}
            {pctLabel} · {formatDuration(elapsed)}
          </span>
          <button
            type="button"
            className="ls-btn ls-btn-ghost h-6 px-1.5"
            onClick={onToggle}
            title="Toggle log"
          >
            <ChevronDown
              className={`size-3.5 transition ${expanded ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          {running ? (
            <button
              type="button"
              className="ls-btn ls-btn-ghost h-6 px-1.5 text-red-500"
              onClick={() => void handleCancel()}
              title="Cancel"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
      <div className="mx-auto max-w-3xl px-4 pb-1.5">
        <ProgressBar percent={percent} indeterminate={indeterminate} tone={tone} />
      </div>
      {expanded ? (
        <div className="mx-auto max-w-3xl px-4 pb-2">
          <div className="grid grid-cols-4 gap-2 py-1">
            <Stat label="files" value={runProgress.scanFilesFound.toLocaleString()} />
            <Stat label="hashed" value={formatBytes(runProgress.bytesHashed)} />
            <Stat label="pushed" value={runProgress.pushed} tone="text-emerald-400" />
            <Stat
              label="failed"
              value={runProgress.failed}
              tone={runProgress.failed ? "text-red-400" : "text-zinc-400"}
            />
          </div>
          <div className="ls-surface-2 h-32 overflow-auto p-2 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
            {logs.length > 0 ? logs.join("\n") : "Waiting for output..."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Welcome5({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        A single workspace: review your profile and plan inline, and watch sync progress stream in a
        persistent strip without leaving the dashboard.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
