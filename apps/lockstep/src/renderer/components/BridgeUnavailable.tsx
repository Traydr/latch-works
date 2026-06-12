export function BridgeUnavailable() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
      <section className="prism-section max-w-lg">
        <h1 className="text-lg font-semibold tracking-tight">Lockstep could not start</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          The desktop bridge is unavailable. This screen usually means the renderer loaded outside
          Electron, dependencies are incomplete, or the preload script failed to register.
        </p>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
          From the repo root, run <code className="font-mono text-xs">pnpm install</code> then{" "}
          <code className="font-mono text-xs">pnpm dev:lockstep</code>. Do not run a separate{" "}
          <code className="font-mono text-xs">pnpm install</code> inside{" "}
          <code className="font-mono text-xs">apps/lockstep</code>.
        </p>
      </section>
    </div>
  );
}
