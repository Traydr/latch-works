import { randomUUID } from "node:crypto";

import type { Job, JobId, PlanId, RootId } from "../contract.js";
import { JobIdSchema } from "../contract.js";
import { abortError, isAbortError, toError } from "../media/run-tool.js";

export interface JobContext {
  signal: AbortSignal;
  /**
   * Call between items. Waits while paused and throws once cancelled. In a background job it
   * first runs any foreground job queued meanwhile, after `settle` resolves: a job that works on
   * several items at once passes a function that waits for its items in flight, so the
   * foreground job never overlaps them.
   */
  checkpoint: (settle?: () => Promise<void>) => Promise<void>;
  progress: (update: { done: number; total: number; label: string }) => void;
}

export interface JobSpec {
  type: Job["type"];
  rootId: RootId | null;
  planId: PlanId | null;
  /** Analysis nobody asked for just now: it runs only when no foreground job waits. */
  background: boolean;
  label: string;
  run: (context: JobContext) => Promise<void>;
}

interface Entry {
  job: Job;
  spec: JobSpec;
  controller: AbortController;
  resume: (() => void) | null;
  pause: Promise<void> | null;
  /** Whether `run` was called; a yielding background job reads as queued but has started. */
  started: boolean;
  /** Set while one of this background job's checkpoints runs foreground jobs. */
  yielding: Promise<void> | null;
}

interface Signal {
  promise: Promise<void>;
  fire: () => void;
}

function newSignal(): Signal {
  let fire: () => void = () => undefined;

  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });

  return { promise, fire };
}

const PROGRESS_INTERVAL_MS = 150;

const KEPT_FINISHED_JOBS = 20;

/**
 * Runs one job at a time, so a scan and an apply never touch the same root together. Foreground
 * jobs run in the order they were asked for, ahead of every queued background job; one queued
 * while a background job runs takes over at that job's next checkpoint. Every state change and
 * (at most every 150 ms) every progress step is reported through `emit`.
 */
export class JobQueue {
  private readonly entries: Entry[] = [];

  private running = false;

  /** Fires when a foreground job is queued, waking paused background jobs to yield to it. */
  private foregroundQueued = newSignal();

  constructor(private readonly emit: (job: Job) => void) {}

  enqueue(spec: JobSpec): Job {
    const job: Job = {
      id: JobIdSchema.parse(randomUUID()),
      type: spec.type,
      rootId: spec.rootId,
      planId: spec.planId,
      background: spec.background,
      label: spec.label,
      state: "queued",
      done: 0,
      total: 0,
      startedAt: Date.now(),
      message: null,
    };

    this.entries.push({
      job,
      spec,
      controller: new AbortController(),
      resume: null,
      pause: null,
      started: false,
      yielding: null,
    });

    this.emit(job);

    if (!spec.background) {
      this.signalForeground();
    }

    void this.drain();

    return job;
  }

  list(): Job[] {
    return this.entries.map((entry) => entry.job);
  }

  /** A job of this type for this root that is queued and has not started, if there is one. */
  waiting(type: Job["type"], rootId: RootId | null): Job | null {
    return (
      this.entries.find(
        (entry) =>
          !entry.started &&
          entry.job.state === "queued" &&
          entry.job.type === type &&
          entry.job.rootId === rootId,
      )?.job ?? null
    );
  }

  /** Makes a waiting background job a foreground one, as when the owner asks for it. */
  promote(id: JobId): Job | null {
    const entry = this.entries.find((candidate) => candidate.job.id === id);

    if (!entry) {
      return null;
    }

    if (!entry.started && entry.spec.background) {
      entry.spec = { ...entry.spec, background: false };
      this.update(entry, { background: false });
      this.signalForeground();
    }

    return entry.job;
  }

  /** Cancels every job that has not finished, as when the engine closes. */
  cancelAll(): void {
    for (const entry of this.entries) {
      if (
        entry.job.state === "queued" ||
        entry.job.state === "running" ||
        entry.job.state === "paused"
      ) {
        this.cancel(entry.job.id);
      }
    }
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

  private signalForeground(): void {
    this.foregroundQueued.fire();
    this.foregroundQueued = newSignal();
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

  private isWaiting(entry: Entry): boolean {
    return !entry.started && entry.job.state === "queued";
  }

  private nextForeground(): Entry | undefined {
    return this.entries.find((entry) => this.isWaiting(entry) && !entry.spec.background);
  }

  private nextQueued(): Entry | undefined {
    return this.nextForeground() ?? this.entries.find((entry) => this.isWaiting(entry));
  }

  /** Runs every queued foreground job to completion inside a background job's checkpoint. */
  private async yieldToForeground(entry: Entry, settle?: () => Promise<void>): Promise<void> {
    await settle?.();

    const wasRunning = entry.job.state === "running";

    if (wasRunning) {
      this.update(entry, { state: "queued" });
    }

    try {
      for (let next = this.nextForeground(); next; next = this.nextForeground()) {
        await this.runEntry(next);
        this.trim();
      }
    } finally {
      // Cancelled meanwhile, it stays cancelled; its next checkpoint throws.
      if (wasRunning && entry.job.state === "queued") {
        this.update(entry, { state: "running" });
      }
    }
  }

  private async checkpoint(entry: Entry, settle?: () => Promise<void>): Promise<void> {
    const { signal } = entry.controller;

    for (;;) {
      if (entry.yielding) {
        await entry.yielding;

        continue;
      }

      if (signal.aborted) {
        throw abortError();
      }

      if (entry.spec.background && this.nextForeground()) {
        const yielding = this.yieldToForeground(entry, settle);
        entry.yielding = yielding;

        try {
          await yielding;
        } finally {
          entry.yielding = null;
        }

        continue;
      }

      if (!entry.pause) {
        return;
      }

      // A paused background job still steps aside for a foreground job queued meanwhile.
      await (entry.spec.background
        ? Promise.race([entry.pause, this.foregroundQueued.promise])
        : entry.pause);
    }
  }

  private async runEntry(entry: Entry): Promise<void> {
    const { signal } = entry.controller;
    let lastEmit = 0;

    entry.started = true;
    this.update(entry, { state: "running", startedAt: Date.now() });

    const context: JobContext = {
      signal,
      checkpoint: (settle) => this.checkpoint(entry, settle),
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
