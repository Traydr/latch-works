import { ArrowUpCircle, Footprints, Play, Plus, Stethoscope, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AlertBanner } from "../components/AlertBanner";
import { DoctorCheckList } from "../components/DoctorCheckList";
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

export function Layout3({ ctrl }: { ctrl: LockstepController }) {
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

  const [mid, setMid] = useState<"dashboard" | "plan">("dashboard");

  useEffect(() => {
    if (screen === "plan") setMid("plan");
    if (screen === "dashboard") setMid("dashboard");
  }, [screen]);

  const showProfile = screen === "profile";

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="flex w-44 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2 px-3 py-3">
          <div className="flex size-6 items-center justify-center rounded-md border border-violet-400/50 bg-violet-500/15 text-violet-600 dark:text-violet-300">
            <Footprints className="size-3.5" aria-hidden />
          </div>
          <span className="text-xs font-semibold tracking-tight">Lockstep</span>
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
              <Plus className="size-3" aria-hidden /> add
            </button>
          </div>
        </div>

        <div className="mt-auto border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1">actions</p>
          <div className="flex flex-col gap-1">
            <RailAction
              icon={Stethoscope}
              label="Doctor"
              disabled={running || !activeProfile}
              onClick={handleDoctor}
            />
            <RailAction
              icon={Play}
              label="Plan"
              primary
              disabled={running || !activeProfile}
              onClick={handlePlan}
            />
            <RailAction
              icon={ArrowUpCircle}
              label="Push"
              primary
              disabled={running || !activeProfile}
              onClick={handlePush}
            />
            <RailAction
              icon={Trash2}
              label="Prune"
              danger
              disabled={running || !activeProfile}
              onClick={handlePrune}
            />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          {showProfile || !activeProfile ? (
            <span className="ls-label">{showProfile ? "profile setup" : "welcome"}</span>
          ) : (
            <>
              <TabBtn
                label="Dashboard"
                active={mid === "dashboard"}
                onClick={() => setMid("dashboard")}
              />
              <TabBtn
                label="Plan"
                active={mid === "plan"}
                disabled={!plan}
                onClick={() => plan && setMid("plan")}
              />
              <span className="ml-auto ls-mono text-[10px] text-zinc-500 truncate">
                {activeProfile?.name}
              </span>
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">
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
              <Welcome3 onCreate={() => setScreen("profile")} />
            ) : null}

            {!showProfile && activeProfile && mid === "dashboard" ? (
              <Dashboard3 ctrl={ctrl} />
            ) : null}

            {!showProfile && activeProfile && mid === "plan" && plan ? (
              <section className="ls-surface flex min-h-[20rem] flex-1 flex-col p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold tracking-tight">Plan results</h2>
                  <PlanLegend counts={plan.counts} />
                </div>
                <PlanList ctrl={ctrl} className="min-h-0 flex-1" />
              </section>
            ) : null}
          </div>
        </div>
      </main>

      {activeProfile && !showProfile ? <ActivityRail3 ctrl={ctrl} /> : null}
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
      className={`rounded px-2 py-1 text-xs transition disabled:opacity-40 ${
        active
          ? "bg-zinc-200/70 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
      }`}
    >
      {label}
    </button>
  );
}

function RailAction({
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
      className={`ls-btn justify-start ${cls}`}
    >
      <Icon className="size-3.5" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

function Dashboard3({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile, plan, sessionToken, setSessionToken } = ctrl;
  if (!activeProfile) return null;
  return (
    <>
      <section className="ls-surface p-3">
        <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1.5">
          {profileFieldList(activeProfile).map((field) => (
            <div key={field.label} className="flex items-center gap-2 min-w-0">
              <span className="ls-label w-16 shrink-0">{field.label}</span>
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
          <h3 className="text-sm font-semibold tracking-tight">Latest plan</h3>
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

function ActivityRail3({ ctrl }: { ctrl: LockstepController }) {
  const { runProgress, running, runLabel, logs, doctorResult, handleCancel } = ctrl;
  const now = useNow(running);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el && logs.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);
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

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="ls-label">activity</span>
        <span
          className={`inline-flex items-center gap-1.5 ls-mono text-[10px] ${
            running ? "text-violet-300" : idle ? "text-zinc-500" : "text-emerald-300"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ${running ? "bg-violet-400 ls-pulse" : idle ? "bg-zinc-600" : "bg-emerald-400"}`}
          />
          {running ? "running" : idle ? "idle" : runProgress.phase}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {idle ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-zinc-500">
              {ctrl.activeProfile?.lastRun
                ? `Last: ${ctrl.activeProfile.lastRun.action} · ${ctrl.activeProfile.lastRun.status}`
                : "No runs yet. Plan or push to begin."}
            </p>
            {doctorResult ? (
              <div>
                <p className="ls-label mb-1">doctor</p>
                <DoctorCheckList result={doctorResult} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {runProgress.currentAction ? <ActionChip action={runProgress.currentAction} /> : null}
              <span
                className="truncate ls-mono text-[11px] text-zinc-600 dark:text-zinc-300"
                title={runProgress.currentPath ?? runLabel}
              >
                {runProgress.currentPath ?? runLabel ?? "Working..."}
              </span>
            </div>
            <ProgressBar percent={percent} indeterminate={indeterminate} tone={tone} />
            <div className="flex items-center justify-between ls-mono text-[10px] text-zinc-500">
              <span>
                {runProgress.itemTotal > 0
                  ? `${runProgress.itemCurrent}/${runProgress.itemTotal}`
                  : (runProgress.scanStage ?? runProgress.phase)}
              </span>
              <span>{formatDuration(elapsed)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="files" value={runProgress.scanFilesFound.toLocaleString()} />
              <Stat label="hashed" value={formatBytes(runProgress.bytesHashed)} />
              <Stat label="pushed" value={runProgress.pushed} tone="text-emerald-400" />
              <Stat
                label="failed"
                value={runProgress.failed}
                tone={runProgress.failed ? "text-red-400" : "text-zinc-400"}
              />
            </div>
            {doctorResult ? <DoctorCheckList result={doctorResult} /> : null}
            <div>
              <p className="ls-label mb-1">log tail</p>
              <div
                ref={logRef}
                className="ls-surface-2 h-32 overflow-auto p-2 ls-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400"
              >
                {logs.length > 0 ? logs.slice(-40).join("\n") : "Waiting for output..."}
              </div>
            </div>
            {running ? (
              <button
                type="button"
                className="ls-btn ls-btn-danger"
                onClick={() => void handleCancel()}
              >
                <X className="size-3.5" aria-hidden /> Cancel run
              </button>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

function Welcome3({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Create a profile to start. Runs will stream live progress in the activity rail on the right
        — you can keep browsing the plan while a sync runs.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
