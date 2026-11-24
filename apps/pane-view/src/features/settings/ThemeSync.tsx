import { useTheme } from "next-themes";
import { useEffect } from "react";
import { THEME_COLOR_METAS, THEME_COLORS } from "./theme-color";
import type { AppSettings } from "./types";

export function ThemeSync({ theme }: { theme: AppSettings["theme"] }) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  return null;
}

/**
 * Keeps the `theme-color` metas on the page's background. The document ships one per system
 * colour scheme, which is right while the theme follows the system. When the owner picks light
 * or dark, both metas take that theme's colour, so the status bar never shows the other one.
 */
export function ThemeColorSync() {
  const { theme } = useTheme();

  useEffect(() => {
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');

    for (const meta of metas) {
      const authored = THEME_COLOR_METAS.find((entry) => entry.media === meta.media);

      if (theme === "dark" || theme === "light") {
        meta.content = THEME_COLORS[theme];
      } else if (authored) {
        meta.content = authored.content;
      }
    }
  }, [theme]);

  return null;
}
