import { EmptyState } from "../../../../ui/ui";

export function BridgeUnavailable() {
  return (
    <EmptyState title="Sync could not start">
      Sync's desktop bridge is unavailable: the preload did not register it, or dependencies are
      missing. From the repository, run <code>pnpm install</code>, then{" "}
      <code>pnpm --filter @latch-works/oriel start</code>.
    </EmptyState>
  );
}
