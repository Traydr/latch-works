import { ModeLayout } from "../../../shell/ModeLayout";
import { AppLayout } from "./components/AppLayout";
import { BridgeUnavailable } from "./components/BridgeUnavailable";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLockstepController } from "./hooks/useLockstepController";

/** Sync: Lockstep's window, beside the mode rail. */
export function SyncMode() {
  return (
    <ModeLayout>
      <div className="mode-sync flex min-h-0 flex-1 flex-col">
        <ErrorBoundary>{window.lockstep ? <SyncApp /> : <BridgeUnavailable />}</ErrorBoundary>
      </div>
    </ModeLayout>
  );
}

function SyncApp() {
  const ctrl = useLockstepController();

  return <AppLayout ctrl={ctrl} />;
}
