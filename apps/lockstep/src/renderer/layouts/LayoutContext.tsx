import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { LayoutVariant } from "./types";

const STORAGE_KEY = "lockstep-layout-variant";

interface LayoutContextValue {
  variant: LayoutVariant;
  setVariant: (variant: LayoutVariant) => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

function readStoredVariant(): LayoutVariant {
  if (typeof window === "undefined") {
    return 1;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("record") === "1") {
    return 1;
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  const parsed = Number(stored);
  if (parsed >= 1 && parsed <= 5) {
    return parsed as LayoutVariant;
  }

  return 1;
}

function isRecordMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).get("record") === "1";
}

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [variant, setVariantState] = useState<LayoutVariant>(() => readStoredVariant());

  useEffect(() => {
    if (!isRecordMode()) {
      window.localStorage.setItem(STORAGE_KEY, String(variant));
    }
  }, [variant]);

  const setVariant = useCallback((next: LayoutVariant) => {
    setVariantState(next);
  }, []);

  const value = useMemo(() => ({ variant, setVariant }), [variant, setVariant]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayoutVariant() {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error("useLayoutVariant must be used within LayoutProvider");
  }

  return context;
}
