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

export function Layout2({ ctrl }: { ctrl: LockstepController }) {
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
  const showProfile = screen === "profile";
  const showWorkspace = !showProfile && !!activeProfile;

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Left rail: profile + vertical pipeline + actions. */}
      <aside className="flex w-48 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center gap-2 px-3 py-3">
          <Footprints className="size-3.5 text-violet-500" aria-hidden />
          <span className="text-xs font-semibold tracking-tight">Lockstep</span>
        </div>
        <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1.5">profile</p>
          {settings && settings.profiles.length > 0 ? (
            <ProfileSelect
              profiles={settings.profiles}
              value={settings.activeProfileId ?? ""}
              onChange={(id) => void ctrl.handleProfileChange(id)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setScreen("profile")}
              className="ls-btn w-full justify-start"
            >
              <Plus className="size-3.5" aria-hidden /> Create
            </button>
          )}
        </div>
        {/* Vertical pipeline. */}
        <nav className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <p className="ls-label px-1 pb-1.5">flow</p>
          <ol className="flex flex-col gap-0.5">
            {STAGES.map((stage, index) => {
              const done = stageDone(index, ctrl);
              const active = stageActive(index, ctrl);
              return (
                <li key={stage.label}>
                  <button
                    type="button"
                    disabled={stageDisabled(index, ctrl)}
                    onClick={() => stageClick(index, ctrl)}
                    className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] transition disabled:opacity-40 ${active ? "bg-violet-500/15 text-violet-700 dark:text-violet-200" : done ? "text-emerald-600 dark:text-emerald-300" : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"}`}
                  >
                    <span
                      className={`flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[8px] ${active ? "border-violet-400 bg-violet-500/30 text-violet-100 ls-pulse" : done ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : "border-zinc-600 bg-zinc-800/60 text-zinc-500"}`}
                    >
                      {done ? "✓" : index + 1}
                    </span>
                    <stage.icon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{stage.label}</span>
                  </button>
                  {index < STAGES.length - 1 ? (
                    <div className="ml-[0.9rem] h-2 w-px bg-zinc-300 dark:bg-zinc-700">
                      {done ? <div className="h-full w-px bg-emerald-500/50" /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="mt-auto border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
          <div className="flex flex-col gap-1">
            <RailBtn
              icon={Stethoscope}
              label="Doctor"
              disabled={running || !activeProfile}
              onClick={handleDoctor}
            />
            <RailBtn
              icon={Play}
              label="Plan"
              primary
              disabled={running || !activeProfile}
              onClick={handlePlan}
            />
            <RailBtn
              icon={ArrowUpCircle}
              label="Push"
              primary
              disabled={running || !activeProfile}
              onClick={handlePush}
            />
            <RailBtn
              icon={Trash2}
              label="Prune"
              danger
              disabled={running || !activeProfile}
              onClick={handlePrune}
            />
          </div>
        </div>
      </aside>

      {/* Center: content. */}
      <main className="flex min-w-0 flex-1 flex-col">
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
            <Welcome2 onCreate={() => setScreen("profile")} />
          </div>
        ) : null}
        {showWorkspace ? <Content2 ctrl={ctrl} /> : null}
      </main>

      {/* Right: permanent run panel — signature. */}
      {showWorkspace ? <RunPanel2 ctrl={ctrl} /> : null}
    </div>
  );
}

function Content2({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile, plan, sessionToken, setSessionToken, setScreen, doctorResult } = ctrl;
  if (!activeProfile) return null;
  return (
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
            <TokenInput value={sessionToken} onChange={setSessionToken} profile={activeProfile} />
          </div>
        </section>
        {plan ? (
          <section className="ls-surface p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold tracking-tight">Latest plan</h3>
              <button type="button" className="ls-btn" onClick={() => setScreen("plan")}>
                Review
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
        {doctorResult ? (
          <section className="ls-surface p-3">
            <p className="ls-label mb-1">doctor</p>
            <DoctorCheckList result={doctorResult} />
          </section>
        ) : null}
        {ctrl.screen === "plan" && plan ? (
          <section className="ls-surface h-72 p-3">
            <h3 className="mb-2 text-sm font-semibold tracking-tight">Review changes</h3>
            <PlanList ctrl={ctrl} className="h-full" />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function RunPanel2({ ctrl }: { ctrl: LockstepController }) {
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
    <aside className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="ls-label">activity</span>
        <span
          className={`inline-flex items-center gap-1.5 ls-mono text-[10px] ${running ? "text-violet-300" : idle ? "text-zinc-500" : "text-emerald-300"}`}
        >
          <span
            className={`size-1.5 rounded-full ${running ? "bg-violet-400 ls-pulse" : idle ? "bg-zinc-600" : "bg-emerald-400"}`}
          />
          {running ? "running" : idle ? "idle" : runProgress.phase}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {idle ? (
          <p className="text-xs text-zinc-500">
            {ctrl.activeProfile?.lastRun
              ? `Last: ${ctrl.activeProfile.lastRun.action} · ${ctrl.activeProfile.lastRun.status}`
              : "No runs yet. Plan or push to begin."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <ReservedBar percent={percent} indeterminate={indeterminate} tone={tone} />
            <SyncLine
              action={runProgress.currentAction}
              path={runProgress.currentPath ?? runLabel}
              counter={counter}
              running={running}
            />
            <div className="flex items-center justify-between ls-mono text-[10px] text-zinc-500">
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
            <div>
              <p className="ls-label mb-1">log tail</p>
              <div className="ls-surface-2 h-36 overflow-auto p-2 ls-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
                {logs.length > 0 ? logs.slice(-40).join("\n") : "Waiting..."}
              </div>
            </div>
            {running ? (
              <button
                type="button"
                className="ls-btn ls-btn-danger"
                onClick={() => void handleCancel()}
              >
                Cancel run
              </button>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

function RailBtn({
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
function stageDisabled(index: number, ctrl: LockstepController): boolean {
  if (index === 0) return false;
  if (!ctrl.activeProfile) return true;
  if (index === 2) return !ctrl.plan;
  return false;
}
function stageClick(index: number, ctrl: LockstepController): void {
  if (index === 0) ctrl.setScreen("profile");
  else if (index === 2 && ctrl.plan) ctrl.setScreen("plan");
}

function Welcome2({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Three zones: pipeline on the left, content in the center, live activity on the right. The
        activity panel stays open during runs — watch progress without leaving the dashboard.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
