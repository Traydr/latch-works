export function BridgeUnavailable() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <section className="prism-section max-w-lg">
        <h1 className="text-lg font-semibold tracking-tight">Sync could not start</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          Sync's desktop bridge is unavailable: the preload script did not register it, or
          dependencies are incomplete.
        </p>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
          From the repo root, run <code className="font-mono text-xs">pnpm install</code> then{" "}
          <code className="font-mono text-xs">pnpm --filter @latch-works/oriel start</code>.
        </p>
      </section>
    </div>
  );
}
