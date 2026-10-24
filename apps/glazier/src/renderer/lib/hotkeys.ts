import { useEffect, useRef, useState } from "react";

/** Keys typed into a field belong to the field, not to the view. */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function isPlainKey(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** ⌘ on macOS, Ctrl elsewhere. */
export function isCommandKey(event: KeyboardEvent | MouseEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function isModalOpen(): boolean {
  return document.querySelector("[aria-modal='true']") !== null;
}

/**
 * Listens for keys on the window while `active`, except when a field has focus or a sheet is
 * open. The handler returns true when it used the key, which stops the browser's default.
 */
export function useViewKeys(handler: (event: KeyboardEvent) => boolean, active = true): void {
  const latest = useRef(handler);

  latest.current = handler;

  useEffect(() => {
    if (!active) {
      return;
    }

    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextInputTarget(event.target) || isModalOpen()) {
        return;
      }

      if (latest.current(event)) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", listener);

    return () => window.removeEventListener("keydown", listener);
  }, [active]);
}

/** The current time, refreshed every `intervalMs` while `active`, for "3 min ago" labels. */
export function useNow(active = true, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNow(Date.now());

    const id = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(id);
  }, [active, intervalMs]);

  return now;
}

/** The digit of a number key, from its physical key so ⇧1 still reads as 1. */
export function digitOf(event: KeyboardEvent): number | null {
  const match = /^Digit([1-9])$/.exec(event.code);

  return match?.[1] ? Number(match[1]) : null;
}
