import { isTerminalGatherRunEvent, type GatherRunEvent } from "../shared/gather-run-messages";

export interface GatherRunEventEmitter {
  /** Reports progress immediately; holds a report that hands the queue back until {@link flush}. */
  emit(event: GatherRunEvent): Promise<void>;
  /** Delivers the held report until the background accepts it. Safe when none was held. */
  flush(): Promise<void>;
  /** Ends redelivery, once a newer execution of the same run reports for it. */
  stop(): void;
}

/**
 * Serializes a run's events and withholds the report that ends its hold on the queue: a terminal
 * event, or the permission pause that leaves the job waiting for folder access.
 *
 * The background dispatches the next queued output while handling a terminal event, and answers the
 * event only once that dispatch settles. Reporting completion from inside the execution slot would
 * therefore ask the offscreen document to start the next output while this one still occupies the
 * slot, and the dispatch would come back rejected. Flushing after the slot is released keeps the
 * handoff ordered by construction rather than by messaging latency.
 *
 * `deliver` resolves to whether the background accepted the event. Progress stays best effort;
 * the held report is retried until it is accepted.
 */
export function createGatherRunEventEmitter(
  deliver: (event: GatherRunEvent) => Promise<boolean>,
  wait: (milliseconds: number) => Promise<void> = delay
): GatherRunEventEmitter {
  let queue: Promise<unknown> = Promise.resolve();
  let held: GatherRunEvent | null = null;
  let stopped = false;

  const send = (event: GatherRunEvent): Promise<boolean> => {
    const delivery = queue.then(() => deliver(event));
    queue = delivery.catch(() => undefined);

    return delivery;
  };

  return {
    emit(event) {
      if (!releasesQueue(event)) {
        return send(event).then(() => undefined);
      }

      // A run can report twice — an executor that finishes its own cancellation still unwinds
      // through the caller's abort check. The first terminal report is the authoritative one, and
      // it replaces a permission pause that a cancellation overtook.
      if (!held || !isTerminalGatherRunEvent(held)) {
        held = event;
      }

      return Promise.resolve();
    },
    flush() {
      const event = held;
      held = null;

      return event ? deliverHeld(event) : Promise.resolve();
    },
    stop() {
      stopped = true;
    }
  };

  /**
   * Nothing but this report tells the background the run gave up the queue: until it lands, the
   * stored job stays active and the next one waits. It is therefore retried for as long as this
   * document lives, never dropped; if the document goes away, startup recovery requeues the job.
   * Redelivery is safe: once the run is recorded, a repeated report finds no job and only
   * re-dispatches.
   */
  async function deliverHeld(event: GatherRunEvent): Promise<void> {
    for (let attempt = 0; !stopped; attempt += 1) {
      if (await send(event).catch(() => false)) {
        return;
      }

      await wait(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

/** Backs off to one attempt every 30 seconds, so a struggling background is not flooded. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function releasesQueue(event: GatherRunEvent): boolean {
  return isTerminalGatherRunEvent(event) || event.kind === "permission-required";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
