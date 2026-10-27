import { useEffect } from "react";

import { useModeActive, useShell } from "./shell";

/** The theme's darkness, and how many always-dark screens show over the window. */
const state = { themeDark: false, darkScreens: 0 };

function report(): void {
  window.oriel?.setWindowSurface(state.themeDark || state.darkScreens > 0 ? "dark" : "light");
}

/** The theme now showing, so Windows' window buttons read on it. */
export function reportThemeDark(dark: boolean): void {
  state.themeDark = dark;
  report();
}

/**
 * Marks a screen that covers the window in dark whatever the theme (the viewer, the loupe), so
 * Windows' window buttons over its top right stay light while it shows. A screen left open in a
 * mode out of sight, or under Settings, does not count.
 */
export function useDarkScreen(): void {
  const active = useModeActive();
  const { settings } = useShell();
  const showing = active && settings === null;

  useEffect(() => {
    if (!showing) {
      return;
    }

    state.darkScreens += 1;
    report();

    return () => {
      state.darkScreens -= 1;
      report();
    };
  }, [showing]);
}
