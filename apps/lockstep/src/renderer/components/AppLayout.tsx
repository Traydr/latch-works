import { useEffect, useRef, useState } from "react";

import lockstepIcon from "../../../media/lockstep-icon.svg";
import type { LockstepController, RunController } from "../hooks/useLockstepController";
import { describeLastRun } from "../lib/profile-status";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { AlertBanner } from "./AlertBanner";
import { PLAN_FILTER_INPUT_ID, PlanWorkspace } from "./PlanWorkspace";
import { ProfileRail } from "./ProfileRail";
import { RunPanel } from "./RunPanel";
import { Spinner, useNow } from "./syncPrimitives";

export function AppLayout({ ctrl }: { ctrl: LockstepController }) {
  const { session, profile, plan: planCtrl, run } = ctrl;
  const { screen, settings, activeProfile, error } = session;
  const progress = run.runProgress;
  const [logOpen, setLogOpen] = useState(false);
  /** The push or prune whose finished panel the user closed, by its start time. */
  const [dismissedRunAt, setDismissedRunAt] = useState<number | null>(null);

  const itemRun = progress.kind === "push" || progress.kind === "prune";

  const showRunPanel =
    run.running ||
    (itemRun &&
      progress.phase !== "idle" &&
      progress.startedAt != null &&
      progress.startedAt !== dismissedRunAt);

  const showRunState = showRunPanel && itemRun && progress.queuedAt != null;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setLogOpen((open) => !open);

        return;
      }

      const target = event.target;

      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if (event.key === "/" && !typing) {
        const input = document.getElementById(PLAN_FILTER_INPUT_ID);

        if (input) {
          event.preventDefault();
          input.focus();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex h-[30px] shrink-0 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 dark:border-zinc-800 dark:bg-zinc-900/60">
        <img src={lockstepIcon} className="size-3.5 shrink-0" alt="" />
        <span className="text-xs font-semibold tracking-tight">Lockstep</span>
        {activeProfile ? (
          <>
            <span className="text-xs text-zinc-400 dark:text-zinc-600">/</span>
            <span className="truncate text-xs text-zinc-700 dark:text-zinc-200">
              {activeProfile.name}
            </span>
          </>
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1">
        <ProfileRail
          profiles={settings?.profiles ?? []}
          activeProfileId={settings?.activeProfileId ?? null}
          activePlanCounts={planCtrl.plan?.counts ?? null}
          running={run.running}
          onSelect={(id) => void session.handleProfileChange(id)}
          onCreate={profile.startCreateProfile}
          onEdit={profile.startEditProfile}
          onDoctor={() => void run.handleDoctor()}
          onDelete={(id) => void profile.handleDeleteProfile(id)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error ? (
            <div className="shrink-0 px-3 pt-2">
              <AlertBanner message={error} />
            </div>
          ) : null}
          {screen === "profile" ? (
            <div className="flex-1 overflow-y-auto p-4">
              <ProfileSetupView
                editingProfile={profile.editingProfile}
                form={profile.profileForm}
                onCancel={profile.cancelProfileForm}
                onChange={(patch) => profile.setProfileForm((c) => ({ ...c, ...patch }))}
                onPickFolder={() => void profile.handlePickFolder()}
                onSubmit={(e) => void profile.handleSubmitProfile(e)}
              />
            </div>
          ) : activeProfile ? (
            <PlanWorkspace
              profile={activeProfile}
              session={session}
              plan={planCtrl}
              run={run}
              showRunState={showRunState}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-4">
              <Welcome onCreate={profile.startCreateProfile} />
            </div>
          )}
        </div>

        {showRunPanel ? (
          <RunPanel
            run={run}
            plan={planCtrl}
            onDone={() => setDismissedRunAt(progress.startedAt)}
          />
        ) : null}

        {logOpen ? <LogDrawer run={run} onClose={() => setLogOpen(false)} /> : null}
      </div>

      <StatusBar ctrl={ctrl} logOpen={logOpen} onToggleLog={() => setLogOpen((open) => !open)} />
    </div>
  );
}

function StatusBar({
  ctrl,
  logOpen,
  onToggleLog,
}: {
  ctrl: LockstepController;
  logOpen: boolean;
  onToggleLog: () => void;
}) {
  const { running, runLabel, runProgress: progress } = ctrl.run;
  const activeProfile = ctrl.session.activeProfile;
  const now = useNow(!running, 60_000);
  const lastRun = activeProfile ? describeLastRun(activeProfile, now) : null;
  const processed = progress.pushed + progress.failed + progress.skipped;

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3 border-t border-zinc-200 bg-zinc-50 px-3 ls-mono text-[10.5px] dark:border-zinc-800 dark:bg-zinc-900/60">
      {running ? (
        <>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-violet-700 dark:text-violet-300">
            <Spinner />
            {progress.kind || "run"}
            {progress.itemTotal > 0
              ? ` ${processed.toLocaleString()}/${progress.itemTotal.toLocaleString()}`
              : ""}
          </span>
          <span className="min-w-0 truncate text-zinc-500" title={runLabel}>
            {runLabel}
          </span>
        </>
      ) : (
        <>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            idle
          </span>
          {lastRun ? <span className="min-w-0 truncate text-zinc-500">{lastRun}</span> : null}
        </>
      )}
      <button
        type="button"
        aria-pressed={logOpen}
        onClick={onToggleLog}
        className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 ${logOpen ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
      >
        Log
        <kbd className="rounded border border-zinc-300 px-1 text-[9.5px] dark:border-zinc-700">
          ⌘L
        </kbd>
      </button>
    </footer>
  );
}

function LogDrawer({ run, onClose }: { run: RunController; onClose: () => void }) {
  const { logs, running } = run;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;

    if (el && logs.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  return (
    <section
      aria-label="Run log"
      className="absolute inset-x-0 bottom-0 z-40 flex h-56 flex-col border-t border-zinc-300 bg-white shadow-[0_-12px_30px_rgba(0,0,0,0.25)] dark:border-zinc-700 dark:bg-zinc-950"
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <span className="ls-label">Run log</span>
        <span className="ls-mono text-[10px] text-zinc-500">
          {logs.length} {running ? "· live" : "lines"}
        </span>
        <button
          type="button"
          className="ls-btn ls-btn-ghost ml-auto h-5 px-1.5 text-[10.5px]"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto px-3 py-2 ls-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-600 dark:text-zinc-400"
      >
        {logs.length > 0
          ? logs.join("\n")
          : "No log output yet. Run Plan, Push, or Prune to see activity."}
      </div>
    </section>
  );
}

function Welcome({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="ls-surface flex max-w-md flex-col items-start gap-3 p-4">
      <h2 className="text-sm font-semibold tracking-tight">Welcome to Lockstep</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        A profile pairs a local archive folder with a Pane View server. Plan compares the two, and
        nothing changes on the server until you push.
      </p>
      <button type="button" className="ls-btn ls-btn-cta" onClick={onCreate}>
        Create your first profile
      </button>
    </section>
  );
}
