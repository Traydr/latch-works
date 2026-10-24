import { useEffect, useRef, useState } from "react";

import lockstepIcon from "../../../../../media/modes/lockstep-icon.svg";
import { OfferedFolders } from "../../../../shell/OfferedFolders";
import { baseName } from "../../../../shell/paths";
import { useModeActive, useOfferedFolders } from "../../../../shell/shell";
import { TopBar } from "../../../../ui/ui";
import type { LockstepController, RunController } from "../hooks/useLockstepController";
import { ProfileSetupView } from "../views/ProfileSetupView";
import { AlertBanner } from "./AlertBanner";
import { PLAN_FILTER_INPUT_ID, PlanWorkspace } from "./PlanWorkspace";
import { RunPanel } from "./RunPanel";

/**
 * Sync's page beside its profile sidebar: the profile form, the active profile's plan, or the
 * welcome before any profile. The run floats over the plan's lower right, and the run log (⌘L)
 * along the bottom.
 */
export function SyncPage({ ctrl }: { ctrl: LockstepController }) {
  const { session, profile, plan: planCtrl, run } = ctrl;
  const { screen, activeProfile, error } = session;
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

  const modeActive = useModeActive();

  useEffect(() => {
    if (!modeActive) {
      return;
    }

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
  }, [modeActive]);

  const errorBanner = error ? (
    <div className="shrink-0 px-5 pt-3">
      <AlertBanner message={error} />
    </div>
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {screen === "profile" ? (
        <>
          <TopBar title={profile.editingProfile ? "Edit profile" : "New profile"} />
          {errorBanner}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProfileSetupView
              editingProfile={profile.editingProfile}
              form={profile.profileForm}
              onCancel={profile.cancelProfileForm}
              onChange={(patch) => profile.setProfileForm((c) => ({ ...c, ...patch }))}
              onPickFolder={() => void profile.handlePickFolder()}
              onSubmit={(e) => void profile.handleSubmitProfile(e)}
            />
          </div>
        </>
      ) : activeProfile ? (
        <PlanWorkspace
          profile={activeProfile}
          session={session}
          profiles={profile}
          plan={planCtrl}
          run={run}
          showRunState={showRunState}
          onToggleLog={() => setLogOpen((open) => !open)}
        />
      ) : (
        <>
          <TopBar />
          {errorBanner}
          <Welcome
            onCreate={profile.startCreateProfile}
            onCreateFor={(folder) => {
              profile.startCreateProfile();
              profile.setProfileForm((current) => ({
                ...current,
                name: baseName(folder),
                sourceRoot: folder,
              }));
            }}
          />
        </>
      )}

      {showRunPanel ? (
        <RunPanel run={run} plan={planCtrl} onDone={() => setDismissedRunAt(progress.startedAt)} />
      ) : null}

      {logOpen ? (
        <LogPanel run={run} besideRun={showRunPanel} onClose={() => setLogOpen(false)} />
      ) : null}
    </div>
  );
}

function LogPanel({
  run,
  besideRun,
  onClose,
}: {
  run: RunController;
  /** The run panel holds the lower right, so the log stops short of it. */
  besideRun: boolean;
  onClose: () => void;
}) {
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
      className={`lw-float lw-enter-rise absolute bottom-4 left-4 z-20 flex h-56 flex-col overflow-hidden ${
        besideRun ? "right-[332px]" : "right-4"
      }`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b lw-divider px-4">
        <h2 className="lw-heading">Run log</h2>
        <span className="lw-caption">
          {logs.length.toLocaleString()} {running ? "lines, live" : "lines"}
        </span>
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-sm ml-auto"
          title="⌘L"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-auto px-4 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-600 dark:text-zinc-400"
      >
        {logs.length > 0
          ? logs.join("\n")
          : "Nothing logged yet. Plan, Push and Prune write here as they run."}
      </div>
    </section>
  );
}

function Welcome({
  onCreate,
  onCreateFor,
}: {
  onCreate: () => void;
  /** Starts a profile for a folder another mode already uses. */
  onCreateFor: (folder: string) => void;
}) {
  const offered = useOfferedFolders();

  return (
    <div className="flex flex-1 items-center justify-center p-10 pb-[100px]">
      <div className="flex w-[480px] max-w-full flex-col items-center text-center">
        <img src={lockstepIcon} className="size-14" alt="" />
        <h1 className="mt-4 text-xl font-semibold">Sync a folder to Pane View</h1>
        <p className="mt-2 max-w-[380px] text-sm text-zinc-500 dark:text-zinc-400">
          A profile pairs a local archive folder with a Pane View server. Plan compares the two, and
          nothing changes on the server until you push.
        </p>
        <button type="button" className="lw-btn lw-btn-primary lw-btn-xl mt-6" onClick={onCreate}>
          Add a profile
        </button>
        <OfferedFolders
          folders={offered}
          title="Or sync one you already use"
          onChoose={(folder) => onCreateFor(folder.path)}
        />
      </div>
    </div>
  );
}
