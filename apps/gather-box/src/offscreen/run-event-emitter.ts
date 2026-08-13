import { isTerminalGatherRunEvent, type GatherRunEvent } from "../shared/gather-run-messages";

export interface GatherRunEventEmitter {
  /** Reports progress immediately; holds a terminal report until {@link flush}. */
  emit(event: GatherRunEvent): Promise<void>;
  /** Delivers the held terminal report. Safe to call when no run reported one. */
  flush(): void;
}

/**
 * Serializes a run's events and withholds its terminal report.
 *
 * The background dispatches the next queued output while handling a terminal event, and answers the
 * event only once that dispatch settles. Reporting completion from inside the execution slot would
 * therefore ask the offscreen document to start the next output while this one still occupies the
 * slot, and the dispatch would come back rejected. Flushing after the slot is released keeps the
 * handoff ordered by construction rather than by messaging latency.
 */
export function createGatherRunEventEmitter(
  deliver: (event: GatherRunEvent) => Promise<void>
): GatherRunEventEmitter {
  let queue = Promise.resolve();
  let terminal: GatherRunEvent | null = null;

  const send = (event: GatherRunEvent): Promise<void> => {
    const delivery = queue.then(() => deliver(event));
    queue = delivery.catch(() => undefined);
    return delivery;
  };

  return {
    emit(event) {
      if (!isTerminalGatherRunEvent(event)) {
        return send(event);
      }

      // A run can report twice — an executor that finishes its own cancellation still unwinds
      // through the caller's abort check. The first report is the authoritative one.
      terminal ??= event;
      return Promise.resolve();
    },
    flush() {
      const event = terminal;
      terminal = null;
      if (event) {
        void send(event).catch(() => undefined);
      }
    }
  };
}
