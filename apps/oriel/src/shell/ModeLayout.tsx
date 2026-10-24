import type { ReactNode } from "react";

import { ModeSwitcher } from "./ModeSwitcher";
import { useShell } from "./shell";

/**
 * One mode's window: the sidebar, with the mode switcher at its top and the mode's own navigation
 * below, beside the mode's content. A mode with no navigation of its own gets the rail, so its
 * content has the width.
 */
export function ModeLayout({ sidebar, children }: { sidebar?: ReactNode; children: ReactNode }) {
  const { rail: railChosen, insetTitleBar } = useShell();
  const rail = railChosen || sidebar === undefined;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside
        className={`flex shrink-0 flex-col border-r gz-divider bg-zinc-50 dark:bg-zinc-900/60 ${
          // On macOS the window buttons sit in the top strip; at 16 px in they end near 76 px,
          // so the rail is wide enough to hold them.
          rail ? (insetTitleBar ? "w-[88px] items-center" : "w-14 items-center") : "w-60"
        }`}
      >
        <div className="gz-drag h-[52px] w-full shrink-0" />
        <ModeSwitcher rail={rail} />
        {sidebar}
      </aside>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
