import { useEffect } from "react";

/** The theme's darkness, and how many always-dark screens cover the window. */
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
 * Windows' window buttons over its top right stay light while it shows.
 */
export function useDarkScreen(): void {
  useEffect(() => {
    state.darkScreens += 1;
    report();

    return () => {
      state.darkScreens -= 1;
      report();
    };
  }, []);
}
