import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";

import { ModeSwitcher } from "./ModeSwitcher";
import { SettingsFrame } from "./Settings";
import { useModeActive, useShell } from "./shell";

/**
 * The sidebar's foot: compacts it to the rail of icons, or expands it again, in every mode at
 * once (⌘\ does the same).
 */
function SidebarToggle({ rail }: { rail: boolean }) {
  const { toggleRail, insetTitleBar } = useShell();
  const label = rail ? "Expand sidebar" : "Compact sidebar";

  // The rail's buttons, as the switcher's: 48 px in the 88 px macOS rail, 40 px elsewhere.
  const railButton = insetTitleBar
    ? "size-12 rounded-xl [&_svg]:size-[22px]"
    : "size-10 rounded-lg [&_svg]:size-5";

  return (
    <div className={`w-full shrink-0 pb-3 ${rail ? "flex justify-center" : "px-2"}`}>
      <button
        type="button"
        className={`lw-sidebar-item ${rail ? `justify-center px-0 ${railButton}` : ""}`}
        aria-label={rail ? label : undefined}
        title={`${label}  ⌘\\`}
        data-sidebar-toggle
        onClick={toggleRail}
      >
        {rail ? <PanelLeftOpen /> : <PanelLeftClose />}
        {rail ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
      </button>
    </div>
  );
}

/**
 * One mode's window: the sidebar, with the mode switcher at its top, the mode's own navigation
 * below and the compact toggle at its foot, beside the mode's content. Every mode's sidebar is
 * full or the rail together, as the owner last chose. While Settings is open it covers the
 * window, with the mode's own section, `settings`; the mode stays mounted underneath.
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
          <div className="lw-drag h-[52px] w-full shrink-0" />
          <ModeSwitcher rail={rail} />
          {sidebar ?? <div className="flex-1" />}
          <SidebarToggle rail={rail} />
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}
