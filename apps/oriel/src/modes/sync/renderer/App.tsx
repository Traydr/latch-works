import { ModeLayout } from "../../../shell/ModeLayout";
import { type ModeActivity, useReportActivity } from "../../../shell/shell";
import { BridgeUnavailable } from "./components/BridgeUnavailable";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProfileSidebar } from "./components/ProfileSidebar";
import { SyncPage } from "./components/SyncPage";
import { SyncSettings } from "./components/SyncSettings";
import { type RunController, useLockstepController } from "./hooks/useLockstepController";

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

function SyncApp() {
  const ctrl = useLockstepController();
  const { session, profile, plan, run } = ctrl;

  useReportActivity(runActivity(run));

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
