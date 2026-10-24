interface QueuedScan {
  drop: () => void;
  requestId: number;
  run: () => Promise<void>;
}

/** The catalog worker controls the queue drives. Neither rejects. */
interface ScanQueueWorker {
  /** Asks the running scan, if any, to stop early. */
  cancelScan: () => Promise<void>;
  /** Resolves once no scan is running, however the last one ended. */
  waitForScan: () => Promise<void>;
}

/**
 * Runs scan requests one at a time, in the order they arrive. A request that arrives while a scan
 * runs cancels that scan and starts once it has ended. When several pile up, only the most recent
 * one runs; the older ones resolve as superseded without starting. The folder left on screen is
 * therefore always the last one asked for, and one request's authorization and settings steps
 * never interleave with another's.
 */
export class ScanQueue {
  private latestRequestId = 0;
  private runningRequestId = 0;
  private pending: QueuedScan | null = null;
  private draining = false;

  constructor(private readonly worker: ScanQueueWorker) {}

  /**
   * Queues `start`, which receives `isLatest` to check whether a newer request has arrived since.
   * Resolves with what `start` returns, or with `superseded` when a newer request replaced this
   * one before it ran.
   */
  request<T>(start: (isLatest: () => boolean) => Promise<T>, superseded: T): Promise<T> {
    this.latestRequestId += 1;
    const requestId = this.latestRequestId;

    return new Promise<T>((resolve, reject) => {
      this.pending?.drop();
      this.pending = {
        drop: () => resolve(superseded),
        requestId,
        run: () => start(() => this.latestRequestId === requestId).then(resolve, reject),
      };

      if (this.draining) {
        // A request still setting up sees `isLatest` turn false and never starts its scan; one
        // whose scan is running gets it cancelled. The worker handles the cancel after any start
        // already sent, so it always reaches the scan it is meant for.
        void this.worker.cancelScan();

        return;
      }

      void this.drain();
    });
  }

  /**
   * Whether the scan that ran last belongs to the most recent request. Once a newer request is
   * queued, the running scan's events are stale and must not reach the renderer.
   */
  isRunningLatest(): boolean {
    return this.runningRequestId === this.latestRequestId;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    let next = this.pending;

    while (next) {
      this.pending = null;
      this.runningRequestId = next.requestId;
      await next.run();
      await this.worker.waitForScan();
      next = this.pending;
    }

    this.draining = false;
  }
}
