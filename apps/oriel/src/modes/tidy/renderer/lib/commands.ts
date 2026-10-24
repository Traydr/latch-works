import { useEffect, useRef } from "react";

/** Commands a view can take over from the shell while it is on screen. */
type ViewCommand = "select-all";

const handlers = new Map<ViewCommand, Array<() => void>>();

/** Lets the current view handle a menu command; the newest registration wins. */
export function useCommandHandler(command: ViewCommand, handler: () => void): void {
  const latest = useRef(handler);

  latest.current = handler;

  useEffect(() => {
    const run = () => latest.current();

    handlers.set(command, [...(handlers.get(command) ?? []), run]);

    return () => {
      handlers.set(
        command,
        (handlers.get(command) ?? []).filter((candidate) => candidate !== run),
      );
    };
  }, [command]);
}

/** Runs the view's handler for a command; false when no view handles it. */
export function dispatchCommand(command: ViewCommand): boolean {
  const handler = handlers.get(command)?.at(-1);

  handler?.();

  return handler !== undefined;
}
