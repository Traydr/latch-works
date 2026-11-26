import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface Notice {
  message: string;
  tone?: "default" | "error";
  action?: { label: string; run: () => void };
}

interface ShownNotice extends Notice {
  id: number;
}

/** How long a notice stays before it goes on its own. */
const NOTICE_MS = 6_000;

/** One notice at a time at the foot of the page; a new one replaces the last. */
export function useFootNotice() {
  const [notice, setNotice] = useState<ShownNotice | null>(null);
  const nextId = useRef(0);

  const notify = useCallback((next: Notice) => {
    nextId.current += 1;
    setNotice({ ...next, id: nextId.current });
  }, []);

  const dismiss = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);

    return () => window.clearTimeout(timer);
  }, [notice]);

  return { dismiss, notice, notify };
}

export function FootNotice({
  notice,
  onDismiss,
}: {
  notice: ShownNotice | null;
  onDismiss: () => void;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,var(--safe-area-bottom))] z-40 flex justify-center px-4"
    >
      {notice ? (
        <div
          key={notice.id}
          className={cn(
            "pointer-events-auto flex max-w-full items-center gap-2 rounded-xl bg-popover py-1.5 pr-1.5 pl-3.5 text-sm text-popover-foreground shadow-float animate-in fade-in-0 slide-in-from-bottom-2",
            notice.tone === "error" && "text-destructive",
          )}
          role="status"
        >
          <span className="min-w-0 truncate">{notice.message}</span>
          {notice.action ? (
            <Button
              onClick={() => {
                notice.action?.run();
                onDismiss();
              }}
              size="sm"
              variant="secondary"
            >
              {notice.action.label}
            </Button>
          ) : null}
          <Button aria-label="Dismiss" onClick={onDismiss} size="icon-sm" variant="ghost">
            <X />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
