import type { ReactNode } from "react";

interface AppShellProps {
  children: ReactNode;
  header: ReactNode;
}

export function AppShell({ children, header }: AppShellProps) {
  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-zinc-50 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-4">
        <div className="pointer-events-auto w-full max-w-5xl">{header}</div>
      </div>
      <main className="flex-1 overflow-x-hidden overflow-y-auto px-4 pb-28 pt-24">
        <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-4">{children}</div>
      </main>
    </div>
  );
}
