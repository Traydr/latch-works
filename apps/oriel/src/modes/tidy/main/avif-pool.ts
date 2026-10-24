import path from "node:path";

import type { StillEncodeRequest, StillEncodeResult } from "@latch-works/glazier-core";
import { type UtilityProcess, utilityProcess } from "electron";

import { WorkerOutboundSchema } from "../shared/messages";

interface Job {
  id: number;
  request: StillEncodeRequest;
  resolve: (result: StillEncodeResult) => void;
  reject: (error: Error) => void;
}

interface Slot {
  process: UtilityProcess;
  ready: boolean;
  job: Job | null;
}

/**
 * A pool of AVIF worker processes. Each runs one encode at a time; jobs wait for a free worker.
 * A worker that crashes fails its job and is replaced.
 */
export class AvifPool {
  private readonly slots: Slot[] = [];

  private readonly queue: Job[] = [];

  constructor(
    private readonly size: number,
    private readonly args: string[],
  ) {}

  encode(id: number, request: StillEncodeRequest): Promise<StillEncodeResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, request, resolve, reject });
      this.pump();
    });
  }

  /** Drops a queued job; one already encoding finishes and its result is ignored. */
  cancel(id: number): void {
    const index = this.queue.findIndex((job) => job.id === id);

    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.process.kill();
    }

    this.slots.length = 0;
  }

  private pump(): void {
    while (this.slots.length < Math.min(this.size, this.queue.length + this.busyCount())) {
      this.spawn();
    }

    for (const slot of this.slots) {
      if (slot.ready && slot.job === null) {
        const job = this.queue.shift();

        if (!job) {
          return;
        }

        slot.job = job;
        slot.process.postMessage({ type: "encode", id: job.id, request: job.request });
      }
    }
  }

  private busyCount(): number {
    return this.slots.filter((slot) => slot.job !== null).length;
  }

  private spawn(): void {
    const child = utilityProcess.fork(path.join(__dirname, "avif-worker.cjs"), this.args, {
      serviceName: "Oriel Tidy AVIF encoder",
    });

    const slot: Slot = { process: child, ready: false, job: null };
    this.slots.push(slot);

    child.on("message", (raw) => {
      const parsed = WorkerOutboundSchema.safeParse(raw);

      if (!parsed.success) {
        return;
      }

      const message = parsed.data;

      if (message.type === "ready") {
        slot.ready = true;
      } else if (slot.job && slot.job.id === message.id) {
        const job = slot.job;
        slot.job = null;

        if (message.type === "encoded") {
          job.resolve(message.result);
        } else {
          job.reject(new Error(message.message));
        }
      }

      this.pump();
    });

    child.on("exit", () => {
      const index = this.slots.indexOf(slot);

      if (index >= 0) {
        this.slots.splice(index, 1);
      }

      slot.job?.reject(new Error("The AVIF encoder stopped unexpectedly."));
      slot.job = null;

      if (this.queue.length > 0) {
        this.pump();
      }
    });
  }
}
