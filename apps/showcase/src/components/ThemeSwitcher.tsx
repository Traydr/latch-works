import { useEffect, useState } from "react";
import { defaultTheme, type ThemeId, themeStorageKey, themes } from "@/data/themes";

function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
  localStorage.setItem(themeStorageKey, id);
}

export function ThemeSwitcher() {
  const [active, setActive] = useState<ThemeId>(defaultTheme);

  useEffect(() => {
    const stored = localStorage.getItem(themeStorageKey) as ThemeId | null;
    const initial =
      stored && themes.some((theme) => theme.id === stored) ? stored : defaultTheme;
    setActive(initial);
    applyTheme(initial);
  }, []);

  function selectTheme(id: ThemeId) {
    setActive(id);
    applyTheme(id);
  }

  return (
    <nav
      className="theme-switcher fixed right-0 top-1/2 z-[100] flex -translate-y-1/2 flex-col border border-border/80 bg-card/95 shadow-lg backdrop-blur-md"
      aria-label="Design theme switcher"
      style={{ borderRadius: "var(--radius, 0.5rem) 0 0 var(--radius, 0.5rem)" }}
    >
      {themes.map((theme) => {
        const isActive = active === theme.id;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => selectTheme(theme.id)}
            title={`${theme.name}: ${theme.description}`}
            aria-label={`Switch to design ${theme.label}: ${theme.name}`}
            aria-pressed={isActive}
            className={[
              "group relative flex h-11 w-11 items-center justify-center text-sm font-semibold transition",
              "border-b border-border/50 last:border-b-0",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            {theme.label}
            <span
              className="pointer-events-none absolute right-full mr-2 hidden whitespace-nowrap rounded px-2 py-1 text-xs font-normal group-hover:block"
              style={{
                background: "var(--card)",
                color: "var(--foreground)",
                border: "1px solid var(--border)",
              }}
            >
              {theme.name}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
