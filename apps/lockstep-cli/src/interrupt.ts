const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** Shell convention: 128 plus the signal number. */
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } satisfies Record<InterruptSignal, number>;

/** How long a cancelled push or prune gets to finalize its sync run before the CLI gives up. */
const CLEANUP_GRACE_MS = 15_000;

export interface InterruptWatch {
  /** The exit code for the signal that aborted the run, or undefined while none has arrived. */
  exitCode(): number | undefined;
  signal: AbortSignal;
  stop(): void;
}

/**
 * Turns Ctrl+C (or SIGTERM) into an abort so push and prune can finalize their sync run as
 * cancelled; without it Node exits at once and Pane View keeps the run marked running. A second
 * signal, or cleanup outlasting the grace period, exits immediately.
 */
export function watchInterrupts(): InterruptWatch {
  const controller = new AbortController();
  let received: InterruptSignal | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const forceExit = (reason: string, exitCode: number): never => {
    console.error(
      `\n${reason} If a sync run had started, Pane View shows it as running until it is ` +
        "cancelled on the management page.",
    );
    process.exit(exitCode);
  };

  const onSignal = (signal: InterruptSignal): void => {
    if (received) {
      forceExit("Quitting without waiting for cleanup.", EXIT_CODES[signal]);
    }

    received = signal;
    console.error(
      "\nCancelling; a started sync run is closed as cancelled. Press Ctrl+C again to quit now.",
    );
    controller.abort(new Error(`Cancelled by ${signal}.`));
    graceTimer = setTimeout(
      () => forceExit("Cleanup did not finish in time.", EXIT_CODES[signal]),
      CLEANUP_GRACE_MS,
    );
    graceTimer.unref();
  };

  for (const signal of INTERRUPT_SIGNALS) {
    process.on(signal, onSignal);
  }

  return {
    exitCode: () => (received ? EXIT_CODES[received] : undefined),
    signal: controller.signal,
    stop() {
      clearTimeout(graceTimer);

      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, onSignal);
      }
    },
  };
}
