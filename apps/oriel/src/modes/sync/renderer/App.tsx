import { ModeLayout } from "../../../shell/ModeLayout";
import { type ModeActivity, useReportActivity } from "../../../shell/shell";
import { AppLayout } from "./components/AppLayout";
import { BridgeUnavailable } from "./components/BridgeUnavailable";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SyncSettings } from "./components/SyncSettings";
import { type RunController, useLockstepController } from "./hooks/useLockstepController";

/** Sync: Lockstep's window, beside the mode rail. */
export function SyncMode() {
  if (window.lockstep) {
    return <SyncApp />;
  }

  return (
    <ModeLayout>
      <div className="mode-sync flex min-h-0 flex-1 flex-col">
        <BridgeUnavailable />
      </div>
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

  useReportActivity(runActivity(ctrl.run));

  return (
    <ModeLayout settings={<SyncSettings ctrl={ctrl} />}>
      <div className="mode-sync flex min-h-0 flex-1 flex-col">
        <ErrorBoundary>
          <AppLayout ctrl={ctrl} />
        </ErrorBoundary>
      </div>
    </ModeLayout>
  );
}
