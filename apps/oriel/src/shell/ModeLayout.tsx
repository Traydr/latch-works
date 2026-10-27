import type { ReactNode } from "react";

import { ModeSwitcher } from "./ModeSwitcher";
import { SettingsFrame } from "./Settings";
import { useModeActive, useShell } from "./shell";
import { WindowStrip } from "./WindowStrip";

/**
 * One mode's window: the sidebar, with the mode switcher at its top and the mode's own navigation
 * below, beside the mode's content, whose top bar holds the sidebar's compact toggle. Every mode's
 * sidebar is full or the rail together, as the owner last chose. While Settings is open it covers
 * the window, with the mode's own section, `settings`; the mode stays mounted underneath.
 */
export function ModeLayout({
  sidebar,
  settings,
  children,
}: {
  sidebar?: ReactNode;
  settings?: ReactNode;
  children: ReactNode;
}) {
  const { rail, insetTitleBar, settings: section } = useShell();
  // Only the mode on screen draws Settings; the others stay as they were, hidden.
  const active = useModeActive();
  const settingsOpen = section !== null && active;

  return (
    <>
      {settingsOpen ? <SettingsFrame section={settings} /> : null}
      <div
        hidden={settingsOpen}
        className="flex h-full min-h-0 overflow-hidden bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
      >
        <aside
          className={`flex shrink-0 flex-col border-r lw-divider bg-zinc-50 dark:bg-zinc-900/60 ${
            // On macOS the window buttons sit in the top strip; at 16 px in they end near 76 px,
            // so the rail is wide enough to hold them.
            rail ? (insetTitleBar ? "w-[88px] items-center" : "w-14 items-center") : "w-60"
          }`}
        >
          <WindowStrip rail={rail} />
          <ModeSwitcher rail={rail} />
          {sidebar}
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}
