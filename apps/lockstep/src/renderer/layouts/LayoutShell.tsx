import { useEffect, type ReactNode } from "react";

import { useLayoutVariant } from "./LayoutContext";
import type { LayoutVariant } from "./types";

export function ShowcaseRecordCycle() {
  const { setVariant } = useLayoutVariant();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("record") !== "1") {
      return;
    }

    const variants: LayoutVariant[] = [1, 2, 3, 4, 5];
    let index = 0;
    setVariant(variants[index] ?? 1);

    const interval = window.setInterval(() => {
      index = (index + 1) % variants.length;
      setVariant(variants[index] ?? 1);
    }, 6000);

    return () => window.clearInterval(interval);
  }, [setVariant]);

  return null;
}

export function LayoutShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-full min-h-0">
      {children}
      <ShowcaseRecordCycle />
    </div>
  );
}
