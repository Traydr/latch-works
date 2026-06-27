import { Activity, ArrowUpCircle, Footprints, Play, Plus, Stethoscope, Trash2 } from "lucide-react";

import { AlertBanner } from "../components/AlertBanner";
import { DoctorCheckList } from "../components/DoctorCheckList";
import type { LockstepController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { PlanLegend, PlanList, profileFieldList, TokenInput } from "./pieces";
import {
  ActionChip,
  formatBytes,
  formatDuration,
  PhaseSteps,
  ProgressBar,
  ProportionBar,
  Stat,
  useNow,
} from "./shared";

export function Layout1({ ctrl }: { ctrl: LockstepController }) {
  const {
    screen,
    settings,
    activeProfile,
    running,
    plan,
    error,
    setScreen,
    handleDoctor,
    handlePlan,
    handlePush,
    handlePrune,
  } = ctrl;

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2 px-3 py-3">
          <div className="flex size-6 items-center justify-center rounded-md border border-violet-400/50 bg-violet-500/15 text-violet-600 dark:text-violet-300">
            <Footprints className="size-3.5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold tracking-tight">Lockstep</p>
            <p className="truncate text-[10px] text-zinc-500">sync to Pane View</p>
          </div>
        </div>

        <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1">profiles</p>
          <div className="flex flex-col gap-0.5">
            {settings?.profiles.map((profile) => {
              const active = profile.id === settings.activeProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => void ctrl.handleProfileChange(profile.id)}
                  className={`truncate rounded px-2 py-1 text-left text-xs ${
                    active
                      ? "bg-violet-500/15 text-violet-700 dark:text-violet-200"
                      : "text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  {profile.name}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setScreen("profile")}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-left text-xs text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
            >
              <Plus className="size-3" aria-hidden /> add profile
            </button>
          </div>
        </div>

        <nav className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1">view</p>
          <div className="flex flex-col gap-0.5">
            <NavRow
              label="Dashboard"
              hint="1"
              active={screen === "dashboard"}
              onClick={() => setScreen("dashboard")}
            />
            <NavRow
              label="Plan"
              hint="2"
              active={screen === "plan"}
              disabled={!plan}
              onClick={() => plan && setScreen("plan")}
            />
            <NavRow
              label="Run"
              hint="3"
              active={screen === "run"}
              disabled={!running && ctrl.runProgress.phase === "idle"}
              onClick={() => running && setScreen("run")}
            />
          </div>
        </nav>

        <div className="mt-auto border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1">actions</p>
          <div className="flex flex-col gap-1">
            <ActionRow
              icon={Stethoscope}
              label="Doctor"
              hint="⌘D"
              disabled={running || !activeProfile}
              onClick={handleDoctor}
            />
            <ActionRow
              icon={Play}
              label="Plan"
              hint="⌘P"
              primary
              disabled={running || !activeProfile}
              onClick={handlePlan}
            />
            <ActionRow
              icon={ArrowUpCircle}
              label="Push"
              hint="⌘U"
              primary
              disabled={running || !activeProfile}
              onClick={handlePush}
            />
            <ActionRow
              icon={Trash2}
              label="Prune"
              hint="⌘X"
              danger
              disabled={running || !activeProfile}
              onClick={handlePrune}
            />
          </div>
          <p className="mt-2 px-1 text-[10px] leading-relaxed text-zinc-500">
            Push never deletes. Review the plan, then Apply deletes explicitly.
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {activeProfile ? <StatusStrip1 ctrl={ctrl} /> : null}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
            {error ? <AlertBanner message={error} /> : null}

            {screen === "profile" ? (
              <ProfileSetupView
                form={ctrl.profileForm}
                onCancel={() => setScreen("dashboard")}
                onChange={(patch) => ctrl.setProfileForm((current) => ({ ...current, ...patch }))}
                onPickFolder={() => void ctrl.handlePickFolder()}
                onSubmit={(event) => void ctrl.handleCreateProfile(event)}
              />
            ) : null}

            {screen === "dashboard" && !activeProfile ? (
              <Welcome1 onCreate={() => setScreen("profile")} />
            ) : null}

            {screen === "dashboard" && activeProfile ? <Dashboard1 ctrl={ctrl} /> : null}

            {screen === "plan" && plan ? <PlanList ctrl={ctrl} className="ls-surface p-3" /> : null}

            {screen === "run" ? <Run1 ctrl={ctrl} /> : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function NavRow({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-between rounded px-2 py-1 text-left text-xs transition disabled:opacity-40 ${
        active
          ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
      }`}
    >
      <span>{label}</span>
      <span className="ls-mono text-[9px] text-zinc-400">{hint}</span>
    </button>
  );
}

function ActionRow({
  icon: Icon,
  label,
  hint,
  primary,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  hint: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const cls = primary ? "ls-btn-primary" : danger ? "ls-btn-danger" : "";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className={`ls-btn justify-start ${cls}`}
    >
      <Icon className="size-3.5" aria-hidden />
      <span>{label}</span>
      <span className="ml-auto ls-mono text-[9px] text-zinc-400">{hint}</span>
    </button>
  );
}

function StatusStrip1({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile } = ctrl;
  if (!activeProfile) return null;
  const fields = profileFieldList(activeProfile);
  return (
    <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-1.5 text-[11px] dark:border-zinc-800">
      <span className="ls-mono font-medium text-zinc-700 dark:text-zinc-200">
        {activeProfile.name}
      </span>
      {fields.map((field) => (
        <span key={field.label} className="inline-flex items-center gap-1 min-w-0">
          <span className="ls-label">{field.label}</span>
          <span
            className={`truncate ls-mono ${field.tone ?? "text-zinc-500 dark:text-zinc-400"}`}
            title={field.value}
          >
            {field.value}
          </span>
        </span>
      ))}
    </div>
  );
}

function Dashboard1({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile, plan, sessionToken, setSessionToken, setScreen } = ctrl;
  if (!activeProfile) return null;
  return (
    <>
      <section className="ls-surface p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Dashboard</h2>
          <span className="ls-label">{activeProfile.name}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {profileFieldList(activeProfile).map((field) => (
            <div key={field.label} className="flex items-center gap-2 min-w-0">
              <span className="ls-label w-14 shrink-0">{field.label}</span>
              <span
                className={`truncate ls-mono text-xs ${field.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                title={field.value}
              >
                {field.value}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <TokenInput value={sessionToken} onChange={setSessionToken} profile={activeProfile} />
        </div>
      </section>

      {plan ? (
        <section className="ls-surface p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-tight">Latest plan</h3>
            <button type="button" onClick={() => setScreen("plan")} className="ls-btn">
              View details
            </button>
          </div>
          <div className="mt-2">
            <ProportionBar counts={plan.counts} />
          </div>
          <div className="mt-2">
            <PlanLegend counts={plan.counts} />
          </div>
          <p className="mt-2 ls-mono text-[10px] text-zinc-500">
            {plan.totalFiles.toLocaleString()} files · {formatBytes(plan.totalBytes)} ·{" "}
            {plan.skipped} skipped
          </p>
        </section>
      ) : null}
    </>
  );
}

function Run1({ ctrl }: { ctrl: LockstepController }) {
  const { runProgress, running, runLabel, logs, doctorResult, handleCancel, setScreen } = ctrl;
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

  return (
    <section className="ls-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <PhaseSteps phase={runProgress.phase} action={runProgress.action} />
        <span className="ls-mono text-[10px] tabular-nums text-zinc-500">
          {formatDuration(elapsed)}
        </span>
      </div>

      <ProgressBar
        percent={percent}
        indeterminate={indeterminate}
        tone={tone}
        className="mt-3 h-2"
      />

      <div className="mt-2 flex items-center gap-2">
        {running ? <Activity className="size-3.5 ls-pulse text-violet-400" aria-hidden /> : null}
        {runProgress.currentAction ? (
          <ActionChip action={runProgress.currentAction} className="w-14 shrink-0" />
        ) : null}
        <span
          className="truncate ls-mono text-xs text-zinc-600 dark:text-zinc-300"
          title={runProgress.currentPath ?? runLabel}
        >
          {runProgress.currentPath ?? runLabel ?? "Working..."}
        </span>
        {runProgress.itemTotal > 0 ? (
          <span className="ml-auto ls-mono text-xs tabular-nums text-zinc-400">
            {runProgress.itemCurrent}/{runProgress.itemTotal}
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        <Stat label="files" value={runProgress.scanFilesFound.toLocaleString()} />
        <Stat label="hashed" value={formatBytes(runProgress.bytesHashed)} />
        <Stat label="pushed" value={runProgress.pushed} tone="text-emerald-400" />
        <Stat
          label="failed"
          value={runProgress.failed}
          tone={runProgress.failed ? "text-red-400" : "text-zinc-400"}
        />
      </div>

      {doctorResult ? (
        <div className="mt-3">
          <DoctorCheckList result={doctorResult} />
        </div>
      ) : null}

      <details className="mt-3" open={logs.length > 0}>
        <summary className="ls-label cursor-pointer select-none">log ({logs.length})</summary>
        <div className="mt-2 ls-surface-2 h-40 overflow-auto p-2 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
          {logs.length > 0 ? logs.join("\n") : "Waiting for output..."}
        </div>
      </details>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="ls-btn"
          disabled={!running}
          onClick={() => void handleCancel()}
        >
          Cancel
        </button>
        <button type="button" className="ls-btn" onClick={() => setScreen("dashboard")}>
          Back to dashboard
        </button>
      </div>
    </section>
  );
}

function Welcome1({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Create a profile with your source folder, API URL, and sync token. Lockstep plans changes,
        pushes uploads and updates separately, and only applies remote deletes when you confirm.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
