import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "oriel.sidebar";

/** Where builds before kept the choice made for wide windows, read once as the starting choice. */
const EARLIER_WIDE_KEY = "oriel.sidebar.wide";

function storedRail(): boolean {
  const stored =
    window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(EARLIER_WIDE_KEY);

  return stored === "rail";
}

interface SidebarRail {
  rail: boolean;
  toggle: () => void;
}

/**
 * Whether the sidebar is compact, the rail of icons. It is the owner's choice alone (the toggle at
 * the start of every top bar, or ⌘\), the same in every mode and at any window size, so switching
 * mode or resizing never changes it.
 */
export function useSidebarRail(): SidebarRail {
  const [rail, setRail] = useState(storedRail);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, rail ? "rail" : "full");
  }, [rail]);

  const toggle = useCallback(() => setRail((current) => !current), []);

  return { rail, toggle };
}
