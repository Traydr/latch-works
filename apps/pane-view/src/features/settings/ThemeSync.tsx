import { useTheme } from "next-themes";
import { useEffect } from "react";
import type { AppSettings } from "./types";

export function ThemeSync({ theme }: { theme: AppSettings["theme"] }) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(theme);
  }, [setTheme, theme]);

  return null;
}
