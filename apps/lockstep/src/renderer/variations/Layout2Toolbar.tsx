import { ArrowUpCircle, Footprints, Play, Plus, Stethoscope, Trash2 } from "lucide-react";

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
  PhaseSteps,
  ProgressBar,
  Stat,
  useNow,
} from "./shared";

export function Layout2({ ctrl }: { ctrl: LockstepController }) {
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/80 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
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

        <div className="mx-2 hidden min-w-0 flex-1 items-center justify-center sm:flex">
          <div className="relative w-full max-w-sm">
            <input
              className="ls-input h-7 text-xs"
              value={ctrl.filter}
              onChange={(event) => ctrl.setFilter(event.target.value)}
              placeholder={plan ? "Filter plan by path  ⌘K" : "Search…  ⌘K"}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="ls-btn inline-flex h-7"
            onClick={() => setScreen("profile")}
          >
            <Plus className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">Profile</span>
          </button>
          <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <ToolBtn
            icon={Stethoscope}
            label="Doctor"
            disabled={running || !activeProfile}
            onClick={handleDoctor}
          />
          <ToolBtn
            icon={Play}
            label="Plan"
            primary
            disabled={running || !activeProfile}
            onClick={handlePlan}
          />
          <ToolBtn
            icon={ArrowUpCircle}
            label="Push"
            primary
            disabled={running || !activeProfile}
            onClick={handlePush}
          />
          <ToolBtn
            icon={Trash2}
            label="Prune"
            danger
            disabled={running || !activeProfile}
            onClick={handlePrune}
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
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
            <Welcome2 onCreate={() => setScreen("profile")} />
          ) : null}

          {screen === "dashboard" && activeProfile ? <Dashboard2 ctrl={ctrl} /> : null}

          {screen === "plan" && plan ? (
            <section className="ls-surface flex min-h-[24rem] flex-1 flex-col p-3">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-tight">Plan results</h2>
                <PlanLegend counts={plan.counts} />
              </div>
              <PlanList ctrl={ctrl} className="min-h-0 flex-1" />
            </section>
          ) : null}

          {screen === "run" ? <Run2 ctrl={ctrl} /> : null}
        </div>
      </main>
    </div>
  );
}

function ToolBtn({
  icon: Icon,
  label,
  primary,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Play;
  label: string;
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
      className={`ls-btn h-7 ${cls}`}
      title={label}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function Dashboard2({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile, plan, sessionToken, setSessionToken, setScreen } = ctrl;
  if (!activeProfile) return null;
  const counts = plan?.counts;
  const total = counts ? counts.upload + counts.update + counts.delete + counts.keep : 0;
  const tiles: Array<{ key: string; value: number; tone: string; bar: string }> = [
    { key: "upload", value: counts?.upload ?? 0, tone: "text-sky-300", bar: "bg-sky-500" },
    { key: "update", value: counts?.update ?? 0, tone: "text-amber-300", bar: "bg-amber-500" },
    { key: "delete", value: counts?.delete ?? 0, tone: "text-red-300", bar: "bg-red-500" },
    { key: "keep", value: counts?.keep ?? 0, tone: "text-zinc-300", bar: "bg-zinc-600" },
  ];

  return (
    <>
      <section className="ls-surface p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
          <span className="ls-label">dashboard</span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {profileFieldList(activeProfile).map((field) => (
            <div key={field.label} className="flex items-center gap-2 min-w-0">
              <dt className="ls-label w-14 shrink-0">{field.label}</dt>
              <dd
                className={`truncate ls-mono text-xs ${field.tone ?? "text-zinc-600 dark:text-zinc-300"}`}
                title={field.value}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <TokenInput value={sessionToken} onChange={setSessionToken} profile={activeProfile} />
        </div>
      </section>

      {plan && counts ? (
        <section className="ls-surface p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-tight">Latest plan</h3>
            <button type="button" className="ls-btn" onClick={() => setScreen("plan")}>
              View details
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map((tile) => (
              <div key={tile.key} className="ls-surface-2 px-2.5 py-2">
                <p className="ls-label">{tile.key}</p>
                <p className={`mt-0.5 ls-mono text-lg font-semibold tabular-nums ${tile.tone}`}>
                  {tile.value.toLocaleString()}
                </p>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className={`h-full ${tile.bar}`}
                    style={{ width: total ? `${(tile.value / total) * 100}%` : "0%" }}
                  />
                </div>
              </div>
            ))}
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

function Run2({ ctrl }: { ctrl: LockstepController }) {
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
  const pctLabel = percent == null ? "—" : `${Math.round(percent * 100)}%`;

  return (
    <section className="ls-surface mx-auto max-w-xl p-4">
      <div className="flex items-center justify-between">
        <PhaseSteps phase={runProgress.phase} action={runProgress.action} />
        <span className="ls-mono text-xs tabular-nums text-zinc-300">{pctLabel}</span>
      </div>

      <ProgressBar
        percent={percent}
        indeterminate={indeterminate}
        tone={tone}
        className="mt-3 h-2.5"
      />

      <div className="mt-2 flex items-center gap-2">
        {runProgress.currentAction ? <ActionChip action={runProgress.currentAction} /> : null}
        <span
          className="truncate ls-mono text-xs text-zinc-600 dark:text-zinc-300"
          title={runProgress.currentPath ?? runLabel}
        >
          {runProgress.currentPath ?? runLabel ?? "Working..."}
        </span>
        <span className="ml-auto ls-mono text-[10px] tabular-nums text-zinc-500">
          {formatDuration(elapsed)}
        </span>
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

      <details className="mt-3">
        <summary className="ls-label cursor-pointer select-none">log ({logs.length})</summary>
        <div className="mt-2 ls-surface-2 h-40 overflow-auto p-2 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
          {logs.length > 0 ? logs.join("\n") : "Waiting for output..."}
        </div>
      </details>

      <div className="mt-3 flex justify-center gap-2">
        <button
          type="button"
          className="ls-btn"
          disabled={!running}
          onClick={() => void handleCancel()}
        >
          Cancel
        </button>
        <button type="button" className="ls-btn" onClick={() => setScreen("dashboard")}>
          Back
        </button>
      </div>
    </section>
  );
}

function Welcome2({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Connect a local archive folder to your private Pane View instance. Plan changes, push
        uploads and updates, and apply deletes explicitly.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
