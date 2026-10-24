import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "oriel.theme";

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

function storedChoice(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  return CHOICES.find((choice) => choice === stored) ?? "system";
}

interface Theme {
  choice: ThemeChoice;
  choose: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<Theme | null>(null);

/**
 * One theme for every mode: the system's appearance unless the owner picks one. Colours switch
 * without animating, so a flip does not smear every element's transition across the window.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);

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

  const choose = useCallback((next: ThemeChoice) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    setChoice(next);
  }, []);

  const value = useMemo(() => ({ choice, choose }), [choice, choose]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);

  if (!theme) {
    throw new Error("useTheme needs a ThemeProvider.");
  }

  return theme;
}
