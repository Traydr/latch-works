import { randomUUID } from "node:crypto";

import type { Job, JobId, RootId } from "../contract.js";
import { JobIdSchema } from "../contract.js";
import { abortError, isAbortError, toError } from "../media/run-tool.js";

export interface JobContext {
  signal: AbortSignal;
  /** Waits while paused and throws once cancelled. */
  checkpoint: () => Promise<void>;
  progress: (update: { done: number; total: number; label: string }) => void;
}

export interface JobSpec {
  type: Job["type"];
  rootId: RootId | null;
  label: string;
  run: (context: JobContext) => Promise<void>;
}

interface Entry {
  job: Job;
  spec: JobSpec;
  controller: AbortController;
  resume: (() => void) | null;
  pause: Promise<void> | null;
}

const PROGRESS_INTERVAL_MS = 150;

const KEPT_FINISHED_JOBS = 20;

/**
 * Runs jobs one at a time, in the order they were asked for, so a scan and an apply never touch
 * the same root together. Every state change and (at most every 150 ms) every progress step is
 * reported through `emit`.
 */
export class JobQueue {
  private readonly entries: Entry[] = [];

  private running = false;

  constructor(private readonly emit: (job: Job) => void) {}

  enqueue(spec: JobSpec): Job {
    const job: Job = {
      id: JobIdSchema.parse(randomUUID()),
      type: spec.type,
      rootId: spec.rootId,
      label: spec.label,
      state: "queued",
      done: 0,
      total: 0,
      startedAt: Date.now(),
      message: null,
    };

    this.entries.push({ job, spec, controller: new AbortController(), resume: null, pause: null });
    this.emit(job);
    void this.drain();

    return job;
  }

  list(): Job[] {
    return this.entries.map((entry) => entry.job);
  }

  /** True when a job of this type for this root is queued or running. */
  isPending(type: Job["type"], rootId: RootId | null): boolean {
    return this.entries.some(
      (entry) =>
        entry.job.type === type &&
        entry.job.rootId === rootId &&
        (entry.job.state === "queued" ||
          entry.job.state === "running" ||
          entry.job.state === "paused"),
    );
  }

  cancel(id: JobId): void {
    const entry = this.entries.find((candidate) => candidate.job.id === id);

    if (!entry) {
      return;
    }

    entry.controller.abort(abortError());
    entry.resume?.();

    if (entry.job.state === "queued") {
      this.update(entry, { state: "cancelled" });
    }
  }

  setPaused(id: JobId, paused: boolean): void {
    const entry = this.entries.find((candidate) => candidate.job.id === id);

    if (!entry || (entry.job.state !== "running" && entry.job.state !== "paused")) {
      return;
    }

    if (paused && entry.pause === null) {
      entry.pause = new Promise((resolve) => {
        entry.resume = resolve;
      });
      this.update(entry, { state: "paused" });
    } else if (!paused && entry.pause !== null) {
      entry.resume?.();
      entry.pause = null;
      entry.resume = null;
      this.update(entry, { state: "running" });
    }
  }

  private update(entry: Entry, patch: Partial<Job>): void {
    entry.job = { ...entry.job, ...patch };
    this.emit(entry.job);
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      for (let entry = this.nextQueued(); entry; entry = this.nextQueued()) {
        await this.runEntry(entry);
        this.trim();
      }
    } finally {
      this.running = false;
    }
  }

  private nextQueued(): Entry | undefined {
    return this.entries.find((entry) => entry.job.state === "queued");
  }

  private async runEntry(entry: Entry): Promise<void> {
    const { signal } = entry.controller;
    let lastEmit = 0;

    this.update(entry, { state: "running", startedAt: Date.now() });

    const context: JobContext = {
      signal,
      checkpoint: async () => {
        if (entry.pause) {
          await entry.pause;
        }

        if (signal.aborted) {
          throw abortError();
        }
      },
      progress: ({ done, total, label }) => {
        entry.job = { ...entry.job, done, total, message: label };
        const now = Date.now();

        if (now - lastEmit >= PROGRESS_INTERVAL_MS || done === total) {
          lastEmit = now;
          this.emit(entry.job);
        }
      },
    };

    try {
      await entry.spec.run(context);
      this.update(entry, { state: signal.aborted ? "cancelled" : "done" });
    } catch (error) {
      const cause = toError(error);

      this.update(
        entry,
        signal.aborted || isAbortError(cause)
          ? { state: "cancelled", message: "Cancelled" }
          : { state: "failed", message: cause.message },
      );
    }
  }

  private trim(): void {
    const finished = this.entries.filter(
      (entry) =>
        entry.job.state === "done" ||
        entry.job.state === "failed" ||
        entry.job.state === "cancelled",
    );

    for (const entry of finished.slice(0, Math.max(0, finished.length - KEPT_FINISHED_JOBS))) {
      this.entries.splice(this.entries.indexOf(entry), 1);
    }
  }
}
