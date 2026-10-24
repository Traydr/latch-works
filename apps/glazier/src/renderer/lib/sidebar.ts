import { useCallback, useEffect, useState } from "react";

/** Below this window width the sidebar starts as the rail of icons, so the work has the room. */
const NARROW_BELOW = 1180;

type SizeClass = "narrow" | "wide";

const storageKey = (size: SizeClass) => `glazier.sidebar.${size}`;

/** The owner's ⌘\ choice for a size class, or null to follow the width. */
function storedChoice(size: SizeClass): boolean | null {
  const stored = window.localStorage.getItem(storageKey(size));

  return stored === "rail" ? true : stored === "full" ? false : null;
}

interface SidebarRail {
  rail: boolean;
  toggle: () => void;
}

/**
 * Whether the sidebar shows as the 56 px rail: by default under 1180 px, and as ⌘\ last chose
 * for windows of that size class, remembered separately for narrow and wide windows.
 */
export function useSidebarRail(): SidebarRail {
  const [width, setWidth] = useState(() => window.innerWidth);
  const [narrowChoice, setNarrowChoice] = useState(() => storedChoice("narrow"));
  const [wideChoice, setWideChoice] = useState(() => storedChoice("wide"));

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);

    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, []);

  const size: SizeClass = width < NARROW_BELOW ? "narrow" : "wide";
  const choice = size === "narrow" ? narrowChoice : wideChoice;
  const rail = choice ?? size === "narrow";

  const toggle = useCallback(() => {
    const next = !rail;

    window.localStorage.setItem(storageKey(size), next ? "rail" : "full");

    if (size === "narrow") {
      setNarrowChoice(next);
    } else {
      setWideChoice(next);
    }
  }, [rail, size]);

  return { rail, toggle };
}
