import { useCallback } from "react";

import { ModeLayout } from "../../../shell/ModeLayout";
import { baseName, closestFolder, parentOf } from "../../../shell/paths";
import {
  type HandOffTarget,
  type ModeActivity,
  useHandOff,
  useReportActivity,
} from "../../../shell/shell";
import { BridgeUnavailable } from "./components/BridgeUnavailable";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProfileSidebar } from "./components/ProfileSidebar";
import { SyncPage } from "./components/SyncPage";
import { SyncSettings } from "./components/SyncSettings";
import {
  type LockstepController,
  type RunController,
  useLockstepController,
} from "./hooks/useLockstepController";

/** Sync: Lockstep's window as one of Oriel's modes, its profiles in the sidebar. */
export function SyncMode() {
  if (window.lockstep) {
    return <SyncApp />;
  }

  return (
    <ModeLayout>
      <BridgeUnavailable />
    </ModeLayout>
  );
}

/** A run's share done: by bytes once a push or prune has its list, by items before that. */
function runActivity({ running, runProgress: progress }: RunController): ModeActivity | null {
  if (!running) {
    return null;
  }

  if (progress.bytesTotal > 0) {
    return {
      kind: "progress",
      ratio: (progress.bytesDone + progress.bytesFailed) / progress.bytesTotal,
    };
  }

  if (progress.itemTotal > 0) {
    return {
      kind: "progress",
      ratio: (progress.pushed + progress.failed + progress.skipped) / progress.itemTotal,
    };
  }

  return { kind: "working" };
}

/**
 * Takes a folder another mode handed Sync: the profile whose archive holds it, or a new profile
 * with the folder filled in.
 */
function useSyncHandOff({ session, profile }: LockstepController, ready: boolean): void {
  const { settings, setScreen, handleProfileChange } = session;
  const { startCreateProfile, setProfileForm } = profile;

  const take = useCallback(
    (target: HandOffTarget) => {
      const folder = target.kind === "file" ? parentOf(target.path) : target.path;

      const holder = closestFolder(
        (settings?.profiles ?? []).map((candidate) => ({
          path: candidate.sourceRoot,
          id: candidate.id,
        })),
        folder,
      );

      if (holder) {
        setScreen("workspace");
        void handleProfileChange(holder.id);

        return;
      }

      startCreateProfile();
      setProfileForm((current) => ({ ...current, name: baseName(folder), sourceRoot: folder }));
    },
    [handleProfileChange, setProfileForm, setScreen, settings, startCreateProfile],
  );

  useHandOff(ready, take);
}

function SyncApp() {
  const ctrl = useLockstepController();
  const { session, profile, plan, run } = ctrl;

  useReportActivity(runActivity(run));
  // A run holds the profile it started with, so a hand-off waits for it to end.
  useSyncHandOff(ctrl, session.settings !== null && !run.running);

  return (
    <ModeLayout
      sidebar={
        <ProfileSidebar
          profiles={session.settings?.profiles ?? []}
          activeProfileId={session.settings?.activeProfileId ?? null}
          activePlanCounts={plan.plan?.counts ?? null}
          running={run.running}
          onSelect={(id) => void session.handleProfileChange(id)}
          onCreate={profile.startCreateProfile}
        />
      }
      settings={<SyncSettings ctrl={ctrl} />}
    >
      <ErrorBoundary>
        <SyncPage ctrl={ctrl} />
      </ErrorBoundary>
    </ModeLayout>
  );
}
