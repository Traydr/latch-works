import { type ReactNode, useEffect, useState } from "react";

type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "oriel.theme";

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

function storedChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  return CHOICES.find((choice) => choice === stored) ?? "system";
}

/**
 * Follows the system's appearance unless the owner picked one. Colours switch without animating,
 * so a flip does not smear every element's transition across the window.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice] = useState<ThemeChoice>(storedChoice);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;

    const apply = () => {
      root.classList.add("theme-switching");
      root.classList.toggle("dark", choice === "dark" || (choice === "system" && media.matches));
      // Reading layout commits the new colours before transitions come back.
      void root.offsetWidth;
      root.classList.remove("theme-switching");
    };

    apply();
    media.addEventListener("change", apply);

    return () => media.removeEventListener("change", apply);
  }, [choice]);

  return children;
}
