import { Settings as SettingsIcon } from "lucide-react";

import { useModeId, useShell } from "./shell";

/**
 * Opens Oriel's Settings at this mode's section. It sits at the bottom left of every mode's
 * sidebar, full or rail, and Settings puts its way back in the same place.
 */
export function SettingsItem() {
  const { rail, insetTitleBar, openSettings } = useShell();
  const mode = useModeId();

  // The rail's buttons, as the switcher's: 48 px in the 88 px macOS rail, 40 px elsewhere.
  const railButton = insetTitleBar
    ? "size-12 rounded-xl [&_svg]:size-[22px]"
    : "size-10 rounded-lg [&_svg]:size-5";

  return (
    <button
      type="button"
      className={`lw-sidebar-item ${rail ? `relative justify-center px-0 ${railButton}` : ""}`}
      aria-label={rail ? "Settings" : undefined}
      title="Settings  ⌘,"
      data-settings-item
      onClick={() => openSettings(mode)}
    >
      <SettingsIcon />
      {rail ? null : <span className="min-w-0 flex-1 truncate">Settings</span>}
    </button>
  );
}
