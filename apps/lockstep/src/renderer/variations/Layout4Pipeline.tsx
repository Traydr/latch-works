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
import type { LockstepPlanItem } from "../../shared/types";
import { AlertBanner } from "../components/AlertBanner";
import { DoctorCheckList } from "../components/DoctorCheckList";
import type { LockstepController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { PlanLegend, profileFieldList, TokenInput } from "./pieces";
import { ActionChip, formatBytes, formatDuration, ProgressBar, Stat, useNow } from "./shared";

export function Layout4({ ctrl }: { ctrl: LockstepController }) {
  const { screen, setScreen, settings, activeProfile, running, plan, error } = ctrl;

  const showProfile = screen === "profile";
  const showPipeline = !showProfile && !!activeProfile;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-100 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md border border-violet-400/50 bg-violet-500/15 text-violet-600 dark:text-violet-300">
            <Footprints className="size-3.5" aria-hidden />
          </div>
          <span className="text-xs font-semibold tracking-tight">Lockstep</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {settings?.profiles.map((profile) => {
            const active = profile.id === settings.activeProfileId;
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => void ctrl.handleProfileChange(profile.id)}
                className={`rounded px-2 py-1 text-xs ${
                  active
                    ? "bg-violet-500/15 text-violet-700 dark:text-violet-200"
                    : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
                }`}
              >
                {profile.name}
              </button>
            );
          })}
          <button type="button" className="ls-btn h-7" onClick={() => setScreen("profile")}>
            <Plus className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            className="ls-btn h-7"
            disabled={running || !activeProfile}
            onClick={() => void ctrl.handleDoctor()}
            title="Doctor"
          >
            <Stethoscope className="size-3.5" aria-hidden />
          </button>
        </div>
      </header>

      {showPipeline ? <Pipeline4 ctrl={ctrl} /> : null}

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
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
            <Welcome4 onCreate={() => setScreen("profile")} />
          ) : null}

          {showPipeline && screen === "dashboard" ? <Dashboard4 ctrl={ctrl} /> : null}
          {showPipeline && screen === "plan" && plan ? <ReviewGrid4 ctrl={ctrl} /> : null}
          {showPipeline && screen === "run" ? <Run4 ctrl={ctrl} /> : null}
        </div>
      </main>
    </div>
  );
}

function Pipeline4({ ctrl }: { ctrl: LockstepController }) {
  const {
    activeProfile,
    plan,
    running,
    runProgress,
    handlePlan,
    handlePush,
    handlePrune,
    setScreen,
  } = ctrl;
  const hasProfile = !!activeProfile;
  const hasPlan = !!plan;
  const activeAction = runProgress.action;

  const nodes: Array<{
    key: string;
    label: string;
    icon: typeof Play;
    done: boolean;
    active: boolean;
    disabled?: boolean;
    onClick?: () => void;
  }> = [
    {
      key: "profile",
      label: "Profile",
      icon: CircleCheck,
      done: hasProfile,
      active: !hasProfile,
      onClick: () => setScreen("profile"),
    },
    {
      key: "plan",
      label: "Plan",
      icon: Play,
      done: hasPlan,
      active: running && activeAction === "plan",
      disabled: running || !hasProfile,
      onClick: () => void handlePlan(),
    },
    {
      key: "review",
      label: "Review",
      icon: ListChecks,
      done: false,
      active: ctrl.screen === "plan",
      disabled: !hasPlan,
      onClick: () => hasPlan && setScreen("plan"),
    },
    {
      key: "push",
      label: "Push",
      icon: ArrowUpCircle,
      done: false,
      active: running && activeAction === "push",
      disabled: running || !hasProfile,
      onClick: () => void handlePush(),
    },
    {
      key: "prune",
      label: "Prune",
      icon: Trash2,
      done: false,
      active: running && activeAction === "prune",
      disabled: running || !hasProfile,
      onClick: () => void handlePrune(),
    },
  ];

  const showBar = running || runProgress.phase !== "idle";
  const percent =
    runProgress.phase === "done"
      ? 1
      : runProgress.itemTotal > 0
        ? runProgress.itemCurrent / runProgress.itemTotal
        : null;
  const indeterminate = percent == null && running;
  const tone =
    runProgress.phase === "error" || runProgress.phase === "cancelled"
      ? "red"
      : runProgress.phase === "done"
        ? "emerald"
        : "violet";

  return (
    <div className="border-b border-zinc-200 bg-zinc-50/60 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/30">
      <div className="mx-auto flex max-w-4xl items-center gap-1">
        {nodes.map((node, index) => (
          <div key={node.key} className="flex flex-1 items-center">
            <button
              type="button"
              disabled={node.disabled}
              onClick={node.onClick}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition disabled:opacity-40 ${
                node.active
                  ? "bg-violet-500/15 text-violet-700 dark:text-violet-200"
                  : node.done
                    ? "text-emerald-600 dark:text-emerald-300"
                    : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
              }`}
            >
              <span
                className={`flex size-4 items-center justify-center rounded-full border text-[9px] ${
                  node.active
                    ? "border-violet-400 bg-violet-500/30 text-violet-100 ls-pulse"
                    : node.done
                      ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                      : "border-zinc-600 bg-zinc-800/60 text-zinc-500"
                }`}
              >
                {node.done ? "✓" : index + 1}
              </span>
              <node.icon className="size-3.5" aria-hidden />
              <span className="hidden sm:inline">{node.label}</span>
            </button>
            {index < nodes.length - 1 ? (
              <div
                className={`mx-1 h-px flex-1 ${node.done ? "bg-emerald-500/40" : "bg-zinc-300 dark:bg-zinc-700"}`}
                aria-hidden
              />
            ) : null}
          </div>
        ))}
      </div>
      {showBar ? (
        <div className="mx-auto mt-1.5 flex max-w-4xl items-center gap-2">
          <ProgressBar
            percent={percent}
            indeterminate={indeterminate}
            tone={tone}
            className="flex-1"
          />
          <span className="ls-mono text-[10px] tabular-nums text-zinc-500">
            {runProgress.itemTotal > 0
              ? `${runProgress.itemCurrent}/${runProgress.itemTotal}`
              : runProgress.phase}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Dashboard4({ ctrl }: { ctrl: LockstepController }) {
  const { activeProfile, plan, sessionToken, setSessionToken } = ctrl;
  if (!activeProfile) return null;
  return (
    <section className="ls-surface p-3">
      <h2 className="text-sm font-semibold tracking-tight">{activeProfile.name}</h2>
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
      {plan ? (
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="flex items-center justify-between">
            <p className="ls-label">latest plan</p>
            <PlanLegend counts={plan.counts} />
          </div>
          <p className="mt-2 ls-mono text-[10px] text-zinc-500">
            {plan.totalFiles.toLocaleString()} files · {formatBytes(plan.totalBytes)} ·{" "}
            {plan.skipped} skipped
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ReviewGrid4({ ctrl }: { ctrl: LockstepController }) {
  const { plan, filter, setFilter } = ctrl;
  if (!plan) return null;
  const query = filter.trim().toLowerCase();
  const byAction = (action: string): LockstepPlanItem[] =>
    plan.items.filter(
      (item) =>
        item.action === action &&
        item.action !== "keep" &&
        (!query || item.path.toLowerCase().includes(query)),
    );

  const groups: Array<{ key: string; label: string; tone: string }> = [
    { key: "upload", label: "Upload", tone: "text-sky-300" },
    { key: "update", label: "Update", tone: "text-amber-300" },
    { key: "delete", label: "Delete", tone: "text-red-300" },
  ];

  return (
    <section className="ls-surface flex min-h-[22rem] flex-1 flex-col p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Review changes</h2>
        <input
          className="ls-input h-7 w-48 text-xs"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by path"
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 md:grid-cols-3">
        {groups.map((group) => {
          const items = byAction(group.key);
          return (
            <div key={group.key} className="ls-surface-2 flex min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-zinc-200/70 px-2.5 py-1.5 dark:border-zinc-800/70">
                <span
                  className={`ls-mono text-[10px] font-medium uppercase tracking-wide ${group.tone}`}
                >
                  {group.label}
                </span>
                <span className="ls-mono text-[10px] tabular-nums text-zinc-400">
                  {items.length}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {items.length === 0 ? (
                  <p className="px-2.5 py-3 text-[11px] text-zinc-500">none</p>
                ) : (
                  <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                    {items.map((item) => (
                      <li
                        key={item.path}
                        className="truncate px-2.5 py-1 ls-mono text-[11px] text-zinc-600 dark:text-zinc-300"
                        title={item.path}
                      >
                        {item.path}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Run4({ ctrl }: { ctrl: LockstepController }) {
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
      <ProgressBar percent={percent} indeterminate={indeterminate} tone={tone} className="h-2" />
      <div className="mt-2 flex items-center gap-2">
        {runProgress.currentAction ? <ActionChip action={runProgress.currentAction} /> : null}
        <span
          className="truncate ls-mono text-xs text-zinc-600 dark:text-zinc-300"
          title={runProgress.currentPath ?? runLabel}
        >
          {runProgress.currentPath ?? runLabel ?? "Working..."}
        </span>
        <span className="ml-auto ls-mono text-[10px] tabular-nums text-zinc-500">
          {runProgress.itemTotal > 0 ? `${runProgress.itemCurrent}/${runProgress.itemTotal}` : "—"}{" "}
          · {formatDuration(elapsed)}
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
        <div className="mt-2 ls-surface-2 h-36 overflow-auto p-2 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400">
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
          Back
        </button>
      </div>
    </section>
  );
}

function Welcome4({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="max-w-xl text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        Sync follows a flow: plan changes, review them, push uploads and updates, then apply deletes
        explicitly. Create a profile to begin.
      </p>
      <button type="button" className="ls-btn ls-btn-primary" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
