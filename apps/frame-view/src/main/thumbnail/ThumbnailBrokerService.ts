import { existsSync } from 'node:fs';
import path from 'node:path';

import { utilityProcess } from 'electron';

import {
  isThumbnailWorkerEvent,
  isThumbnailWorkerResponse,
  type ThumbnailDebugOptions,
  type ThumbnailDiagnosticsSnapshot,
  type ThumbnailJobKind,
  type ThumbnailJobPriority,
  type ThumbnailJobRequest,
  type ThumbnailPerformanceSnapshot,
  type ThumbnailTimingAggregate,
  type ThumbnailWorkerCapabilities,
  type ThumbnailWorkerJobResult,
  type ThumbnailWorkerRequest,
} from '../../shared/thumbnail';
import { RequestAbortError } from '../errors';

export interface ThumbnailPipelineStatus {
  ffmpegAvailable: boolean;
  imageQueueDepth: number;
  imageWorkerCount: number;
  inflightRequests: number;
  sharpAvailable: boolean;
  videoQueueDepth: number;
  videoWorkerCount: number;
}

type MessageListener = (message: unknown) => void;
type ExitListener = (code: number | null) => void;
type ErrorListener = (type: 'FatalError', location: string, report: string) => void;

export interface ThumbnailChildProcessLike {
  kill(): boolean;
  on(event: 'message', listener: MessageListener): this;
  on(event: 'exit', listener: ExitListener): this;
  on(event: 'error', listener: ErrorListener): this;
  postMessage(message: ThumbnailWorkerRequest): void;
}

type ThumbnailChildFactory = (modulePath: string, args: string[]) => ThumbnailChildProcessLike;

interface ThumbnailBrokerConsumer {
  abortHandler: (() => void) | null;
  id: number;
  signal?: AbortSignal;
}

interface ThumbnailBrokerTask {
  cacheKey: string;
  consumers: Map<number, ThumbnailBrokerConsumer>;
  job: ThumbnailJobRequest;
  reject: (error: unknown) => void;
  requestId: number | null;
  requestedAtMs: number;
  resolve: (value: ThumbnailWorkerJobResult) => void;
  sequence: number;
  started: boolean;
  startedAtMs: number | null;
  workerId: number | null;
  promise: Promise<ThumbnailWorkerJobResult>;
}

interface ThumbnailPerformanceAggregateState {
  count: number;
  maxMs: number;
  totalMs: number;
}

interface WorkerSlot {
  activeRequestId: number | null;
  capabilities: ThumbnailWorkerCapabilities | null;
  child: ThumbnailChildProcessLike | null;
  id: number;
  kind: ThumbnailJobKind;
}

export interface ThumbnailBrokerServiceOptions {
  cacheRootPath?: string;
  childFactory?: ThumbnailChildFactory;
  imageWorkers?: number;
  initialDebugOptions?: ThumbnailDebugOptions;
  videoWorkers?: number;
  workerModulePath?: string;
}

const DEFAULT_IMAGE_WORKERS = 2;
const DEFAULT_VIDEO_WORKERS = 1;
const MAX_RECENT_FAILURES = 10;
const MAX_RECENT_WORKER_EVENTS = 10;
const QUEUE_WARNING_THRESHOLD = 100;

function nowMs(): number {
  return Date.now();
}

function createTimingAggregateSnapshot(
  aggregate: ThumbnailPerformanceAggregateState | null,
): ThumbnailTimingAggregate | null {
  if (!aggregate || aggregate.count === 0) {
    return null;
  }

  return {
    averageMs: Math.round((aggregate.totalMs / aggregate.count) * 100) / 100,
    count: aggregate.count,
    maxMs: Math.round(aggregate.maxMs * 100) / 100,
  };
}

function appendRecentEntry(entries: string[], entry: string, maxEntries: number): void {
  entries.push(`${new Date().toISOString()} ${entry}`);
  if (entries.length > maxEntries) {
    entries.splice(0, entries.length - maxEntries);
  }
}

function resolveThumbnailWorkerPath(overridePath?: string): {
  checkedPaths: string[];
  resolvedPath: string;
} {
  const candidates = [
    overridePath,
    path.join(__dirname, 'thumbnail.worker.js'),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar', '.vite', 'build', 'thumbnail.worker.js')
      : null,
    process.resourcesPath
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          '.vite',
          'build',
          'thumbnail.worker.js',
        )
      : null,
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidatePath of candidates) {
    if (existsSync(candidatePath)) {
      return {
        checkedPaths: candidates,
        resolvedPath: candidatePath,
      };
    }
  }

  throw new Error(`Thumbnail worker entry was not found. Checked: ${candidates.join(', ')}`);
}

export class ThumbnailBrokerService {
  private readonly childFactory: ThumbnailChildFactory;
  private readonly cacheRootPath: string;
  private readonly imageQueue: ThumbnailBrokerTask[] = [];
  private readonly requestIdToTask = new Map<number, ThumbnailBrokerTask>();
  private readonly tasksByCacheKey = new Map<string, ThumbnailBrokerTask>();
  private readonly videoQueue: ThumbnailBrokerTask[] = [];
  private readonly workerModulePath: string;
  private readonly workers: WorkerSlot[] = [];

  private abortedCount = 0;
  private currentDebugOptions: ThumbnailDebugOptions;
  private generatedCount = 0;
  private inflightRequests = 0;
  private memoryOfWorkerPathChecks: string[];
  private nextConsumerId = 1;
  private nextRequestId = 1;
  private nextSequence = 1;
  private queueWarningLogged = {
    image: false,
    video: false,
  };
  private readonly recentFailures: string[] = [];
  private readonly recentWorkerEvents: string[] = [];
  private sharpDecodeFailureCount = 0;
  private readonly timings: {
    diskHit: ThumbnailPerformanceAggregateState | null;
    endToEnd: ThumbnailPerformanceAggregateState | null;
    memoryHit: ThumbnailPerformanceAggregateState | null;
    workerGeneration: ThumbnailPerformanceAggregateState | null;
  } = {
    diskHit: null,
    endToEnd: null,
    memoryHit: null,
    workerGeneration: null,
  };
  private videoExtractionFailureCount = 0;
  private workerCrashCount = 0;
  private workerRestartCount = 0;

  constructor(
    private readonly userDataPath: string,
    options: ThumbnailBrokerServiceOptions = {},
  ) {
    this.childFactory =
      options.childFactory ?? ((modulePath, args) => utilityProcess.fork(modulePath, args));
    this.cacheRootPath = options.cacheRootPath ?? userDataPath;
    this.currentDebugOptions = options.initialDebugOptions ?? {
      enableDebugLogging: false,
      enablePerformanceMonitoring: false,
    };

    const workerResolution = resolveThumbnailWorkerPath(options.workerModulePath);
    this.workerModulePath = workerResolution.resolvedPath;
    this.memoryOfWorkerPathChecks = workerResolution.checkedPaths;

    const imageWorkers = options.imageWorkers ?? DEFAULT_IMAGE_WORKERS;
    const videoWorkers = options.videoWorkers ?? DEFAULT_VIDEO_WORKERS;

    for (let index = 0; index < imageWorkers; index += 1) {
      this.workers.push({
        activeRequestId: null,
        capabilities: null,
        child: null,
        id: this.workers.length + 1,
        kind: 'image',
      });
    }

    for (let index = 0; index < videoWorkers; index += 1) {
      this.workers.push({
        activeRequestId: null,
        capabilities: null,
        child: null,
        id: this.workers.length + 1,
        kind: 'video',
      });
    }
  }

  async getThumbnail(
    job: ThumbnailJobRequest,
    signal?: AbortSignal,
  ): Promise<ThumbnailWorkerJobResult> {
    if (signal?.aborted) {
      throw new RequestAbortError();
    }

    let task = this.tasksByCacheKey.get(job.cacheKey);
    if (!task) {
      task = this.createTask(job);
      this.tasksByCacheKey.set(job.cacheKey, task);
      const resultPromise = this.waitForTask(task, signal);
      this.enqueueTask(task);
      return resultPromise;
    }

    if (!task.started) {
      task.job.priority = Math.max(task.job.priority, job.priority) as ThumbnailJobPriority;
      task.sequence = this.nextSequence++;
      this.removeQueuedTask(task);
      this.insertQueuedTask(task);
    }

    return this.waitForTask(task, signal);
  }

  async clearCache(): Promise<void> {
    const queuedTasks = [...this.imageQueue, ...this.videoQueue];
    this.imageQueue.length = 0;
    this.videoQueue.length = 0;

    for (const task of queuedTasks) {
      this.tasksByCacheKey.delete(task.cacheKey);
      task.reject(new RequestAbortError());
    }

    for (const task of [...this.requestIdToTask.values()]) {
      this.cancelActiveTask(task);
    }
  }

  getCapabilities(): ThumbnailWorkerCapabilities | null {
    const capabilities = this.workers
      .map((worker) => worker.capabilities)
      .filter((value): value is ThumbnailWorkerCapabilities => value !== null);

    if (capabilities.length === 0) {
      return null;
    }

    const preferred =
      this.workers.find((worker) => worker.kind === 'video' && worker.capabilities)?.capabilities ??
      capabilities[0];

    return {
      ffmpegAvailable: capabilities.every((value) => value.ffmpegAvailable),
      ffmpegExists: capabilities.every((value) => value.ffmpegExists),
      ffmpegPath: preferred.ffmpegPath,
      ffprobeAvailable: capabilities.every((value) => value.ffprobeAvailable),
      ffprobeExists: capabilities.every((value) => value.ffprobeExists),
      ffprobePath: preferred.ffprobePath,
      probeErrors: [...new Set(capabilities.flatMap((value) => value.probeErrors))],
      sharpAvailable: capabilities.every((value) => value.sharpAvailable),
      workerPath: preferred.workerPath ?? this.workerModulePath,
    };
  }

  getDiagnosticsSnapshot(): ThumbnailDiagnosticsSnapshot {
    return {
      abortedCount: this.abortedCount,
      diskCacheHits: 0,
      generatedCount: this.generatedCount,
      imageQueueDepth: this.imageQueue.length,
      imageWorkerCount: this.workers.filter((worker) => worker.kind === 'image').length,
      inflightRequests: this.inflightRequests,
      memoryCacheHits: 0,
      recentFailures: [...this.recentFailures],
      recentWorkerEvents: [...this.recentWorkerEvents],
      sharpDecodeFailureCount: this.sharpDecodeFailureCount,
      timings: this.getPerformanceSnapshot(),
      videoExtractionFailureCount: this.videoExtractionFailureCount,
      videoQueueDepth: this.videoQueue.length,
      videoWorkerCount: this.workers.filter((worker) => worker.kind === 'video').length,
      workerCrashCount: this.workerCrashCount,
      workerRestartCount: this.workerRestartCount,
    };
  }

  getPerformanceSnapshot(): ThumbnailPerformanceSnapshot | null {
    if (!this.currentDebugOptions.enablePerformanceMonitoring) {
      return null;
    }

    return {
      diskHit: createTimingAggregateSnapshot(this.timings.diskHit),
      endToEnd: createTimingAggregateSnapshot(this.timings.endToEnd),
      memoryHit: createTimingAggregateSnapshot(this.timings.memoryHit),
      workerGeneration: createTimingAggregateSnapshot(this.timings.workerGeneration),
    };
  }

  getStatus(): ThumbnailPipelineStatus {
    const capabilities = this.getCapabilities();

    return {
      ffmpegAvailable: capabilities?.ffmpegAvailable ?? false,
      imageQueueDepth: this.imageQueue.length,
      imageWorkerCount: this.workers.filter((worker) => worker.kind === 'image').length,
      inflightRequests: this.inflightRequests,
      sharpAvailable: capabilities?.sharpAvailable ?? false,
      videoQueueDepth: this.videoQueue.length,
      videoWorkerCount: this.workers.filter((worker) => worker.kind === 'video').length,
    };
  }

  recordDiskHit(durationMs: number): void {
    this.recordTiming('diskHit', durationMs);
  }

  recordMemoryHit(durationMs: number): void {
    this.recordTiming('memoryHit', durationMs);
  }

  setDebugOptions(options: ThumbnailDebugOptions): void {
    this.currentDebugOptions = options;

    for (const worker of this.workers) {
      if (!worker.child) {
        continue;
      }

      try {
        worker.child.postMessage({
          options,
          requestId: 0,
          type: 'set-debug-options',
        });
      } catch {
        // Ignore worker update failures; the worker will be recreated on demand if needed.
      }
    }
  }

  shutdown(): void {
    void this.clearCache();

    for (const worker of this.workers) {
      worker.child?.kill();
      worker.child = null;
      worker.activeRequestId = null;
      worker.capabilities = null;
    }
  }

  private addRecentFailure(message: string): void {
    appendRecentEntry(this.recentFailures, message, MAX_RECENT_FAILURES);
  }

  private addRecentWorkerEvent(message: string): void {
    appendRecentEntry(this.recentWorkerEvents, message, MAX_RECENT_WORKER_EVENTS);
    if (this.currentDebugOptions.enableDebugLogging) {
      console.info(`[thumbnailBroker] ${message}`);
    }
  }

  private createTask(job: ThumbnailJobRequest): ThumbnailBrokerTask {
    let resolve!: (value: ThumbnailWorkerJobResult) => void;
    let reject!: (error: unknown) => void;

    return {
      cacheKey: job.cacheKey,
      consumers: new Map<number, ThumbnailBrokerConsumer>(),
      job: { ...job },
      promise: new Promise<ThumbnailWorkerJobResult>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      }),
      reject,
      requestId: null,
      requestedAtMs: nowMs(),
      resolve,
      sequence: this.nextSequence++,
      started: false,
      startedAtMs: null,
      workerId: null,
    };
  }

  private enqueueTask(task: ThumbnailBrokerTask): void {
    const queue = this.insertQueuedTask(task);
    this.maybeWarnQueueDepth(task.job.kind, queue.length);
    this.pumpQueue(task.job.kind);
  }

  private ensureWorker(worker: WorkerSlot): Promise<ThumbnailChildProcessLike> {
    if (worker.child) {
      return Promise.resolve(worker.child);
    }

    if (this.currentDebugOptions.enableDebugLogging) {
      console.info(
        `[thumbnailBroker] starting ${worker.kind} worker ${worker.id} from ${this.workerModulePath}`,
      );
    }

    const child = this.childFactory(this.workerModulePath, [
      this.userDataPath,
      worker.kind,
      this.cacheRootPath,
    ]);

    child.on('message', (message) => {
      this.handleWorkerMessage(worker, message);
    });

    child.on('exit', () => {
      this.handleWorkerExit(worker, 'Thumbnail worker exited unexpectedly');
    });

    child.on('error', (_type, location) => {
      this.handleWorkerExit(worker, `Thumbnail worker crashed at ${location}`);
    });

    worker.child = child;
    this.addRecentWorkerEvent(
      `${worker.kind} worker ${worker.id} started. Worker path: ${this.workerModulePath}`,
    );

    try {
      child.postMessage({
        options: this.currentDebugOptions,
        requestId: 0,
        type: 'set-debug-options',
      });
    } catch {
      // Ignore debug-option sync errors here.
    }

    return Promise.resolve(child);
  }

  private handleWorkerExit(worker: WorkerSlot, message: string): void {
    if (worker.activeRequestId !== null) {
      const task = this.requestIdToTask.get(worker.activeRequestId);
      if (task) {
        this.requestIdToTask.delete(worker.activeRequestId);
        this.tasksByCacheKey.delete(task.cacheKey);
        this.inflightRequests = Math.max(0, this.inflightRequests - 1);
        task.requestId = null;
        task.workerId = null;
        task.reject(new Error(message));
        this.addRecentFailure(message);
      }
    }

    if (worker.child) {
      this.workerCrashCount += 1;
      this.workerRestartCount += 1;
      this.addRecentWorkerEvent(
        `${worker.kind} worker ${worker.id} exited. Restart will occur on demand.`,
      );
      console.warn(
        `[thumbnailBroker] ${worker.kind} worker ${worker.id} exited and will restart on demand.`,
      );
    }

    worker.activeRequestId = null;
    worker.capabilities = null;
    worker.child = null;
    this.pumpQueue(worker.kind);
  }

  private handleWorkerFailure(
    task: ThumbnailBrokerTask,
    worker: WorkerSlot,
    error: string,
    errorCode:
      | 'abort'
      | 'sharp-decode'
      | 'video-extraction'
      | 'worker-init'
      | 'unknown' = 'unknown',
  ): void {
    if (errorCode === 'abort') {
      this.abortedCount += 1;
      task.reject(new RequestAbortError());
      this.pumpQueue(worker.kind);
      return;
    }

    if (errorCode === 'sharp-decode') {
      this.sharpDecodeFailureCount += 1;
    }

    if (errorCode === 'video-extraction') {
      this.videoExtractionFailureCount += 1;
    }

    this.addRecentFailure(error);
    task.reject(new Error(error));
    this.pumpQueue(worker.kind);
  }

  private handleWorkerMessage(worker: WorkerSlot, message: unknown): void {
    if (isThumbnailWorkerEvent(message)) {
      worker.capabilities = message.capabilities;
      this.addRecentWorkerEvent(
        `${worker.kind} worker ${worker.id} ready. ffmpeg=${message.capabilities.ffmpegAvailable} sharp=${message.capabilities.sharpAvailable}`,
      );

      if (worker.kind === 'video' && !message.capabilities.ffmpegAvailable) {
        console.warn(
          `[thumbnailBroker] video worker ${worker.id} started without ffmpeg. Checked worker path candidates: ${this.memoryOfWorkerPathChecks.join(', ')}`,
        );
      }
      return;
    }

    if (!isThumbnailWorkerResponse(message)) {
      return;
    }

    if (message.requestId === 0) {
      return;
    }

    const task = this.requestIdToTask.get(message.requestId);
    worker.activeRequestId = null;

    if (!task) {
      this.pumpQueue(worker.kind);
      return;
    }

    this.requestIdToTask.delete(message.requestId);
    this.tasksByCacheKey.delete(task.cacheKey);
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    task.requestId = null;
    task.workerId = null;

    if (message.ok === false) {
      this.handleWorkerFailure(task, worker, message.error, message.errorCode);
      return;
    }

    if ('bytes' in message.result) {
      this.generatedCount += 1;
      if (task.startedAtMs !== null) {
        this.recordTiming('workerGeneration', nowMs() - task.startedAtMs);
      }
      this.recordTiming('endToEnd', nowMs() - task.requestedAtMs);
      task.resolve(message.result);
      this.pumpQueue(worker.kind);
      return;
    }

    worker.capabilities = message.result;
    this.pumpQueue(worker.kind);
  }

  private maybeWarnQueueDepth(kind: ThumbnailJobKind, queueDepth: number): void {
    if (queueDepth <= QUEUE_WARNING_THRESHOLD) {
      this.queueWarningLogged[kind] = false;
      return;
    }

    if (this.queueWarningLogged[kind]) {
      return;
    }

    this.queueWarningLogged[kind] = true;
    console.warn(`[thumbnailBroker] ${kind} thumbnail queue depth reached ${queueDepth}.`);
  }

  private pumpQueue(kind: ThumbnailJobKind): void {
    const queue = kind === 'video' ? this.videoQueue : this.imageQueue;
    while (queue.length > 0) {
      const worker = this.workers.find(
        (candidate) => candidate.kind === kind && candidate.activeRequestId === null,
      );
      if (!worker) {
        break;
      }

      const task = queue.shift();
      if (!task) {
        continue;
      }

      if (task.consumers.size === 0) {
        this.tasksByCacheKey.delete(task.cacheKey);
        task.reject(new RequestAbortError());
        continue;
      }

      this.startTask(task, worker);
    }

    if (queue.length <= QUEUE_WARNING_THRESHOLD) {
      this.queueWarningLogged[kind] = false;
    }
  }

  private recordTiming(key: keyof ThumbnailBrokerService['timings'], durationMs: number): void {
    if (
      !this.currentDebugOptions.enablePerformanceMonitoring ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      return;
    }

    const aggregate = this.timings[key] ?? {
      count: 0,
      maxMs: 0,
      totalMs: 0,
    };
    aggregate.count += 1;
    aggregate.totalMs += durationMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
    this.timings[key] = aggregate;
  }

  private removeQueuedTask(task: ThumbnailBrokerTask): void {
    const queue = task.job.kind === 'video' ? this.videoQueue : this.imageQueue;
    const taskIndex = queue.indexOf(task);
    if (taskIndex >= 0) {
      queue.splice(taskIndex, 1);
    }
  }

  private insertQueuedTask(task: ThumbnailBrokerTask): ThumbnailBrokerTask[] {
    const queue = task.job.kind === 'video' ? this.videoQueue : this.imageQueue;
    const insertIndex = queue.findIndex((queuedTask) => {
      if (task.job.priority !== queuedTask.job.priority) {
        return task.job.priority > queuedTask.job.priority;
      }

      return task.sequence > queuedTask.sequence;
    });

    if (insertIndex < 0) {
      queue.push(task);
    } else {
      queue.splice(insertIndex, 0, task);
    }

    return queue;
  }

  private startTask(task: ThumbnailBrokerTask, worker: WorkerSlot): void {
    const requestId = this.nextRequestId++;
    task.started = true;
    task.requestId = requestId;
    task.startedAtMs = nowMs();
    task.workerId = worker.id;
    worker.activeRequestId = requestId;
    this.requestIdToTask.set(requestId, task);
    this.inflightRequests += 1;

    void this.ensureWorker(worker)
      .then((child) => {
        child.postMessage({
          requestId,
          type: 'generate-thumbnail',
          job: task.job,
        });
      })
      .catch((error) => {
        this.requestIdToTask.delete(requestId);
        this.tasksByCacheKey.delete(task.cacheKey);
        worker.activeRequestId = null;
        this.inflightRequests = Math.max(0, this.inflightRequests - 1);
        task.reject(error instanceof Error ? error : new Error('Failed to start thumbnail worker'));
        this.addRecentFailure(
          error instanceof Error ? error.message : 'Failed to start thumbnail worker',
        );
        this.pumpQueue(task.job.kind);
      });
  }

  private async waitForTask(
    task: ThumbnailBrokerTask,
    signal?: AbortSignal,
  ): Promise<ThumbnailWorkerJobResult> {
    if (signal?.aborted) {
      throw new RequestAbortError();
    }

    const consumerId = this.nextConsumerId++;
    const abortHandler = signal
      ? (): void => {
          this.cleanupConsumer(task, consumerId);
        }
      : null;

    if (signal && abortHandler) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    task.consumers.set(consumerId, {
      abortHandler,
      id: consumerId,
      signal,
    });

    try {
      if (!signal) {
        return await task.promise;
      }

      return await new Promise<ThumbnailWorkerJobResult>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new RequestAbortError());
        };

        if (signal.aborted) {
          reject(new RequestAbortError());
          return;
        }

        signal.addEventListener('abort', onAbort, { once: true });
        task.promise.then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
      });
    } finally {
      this.cleanupConsumer(task, consumerId);
    }
  }

  private cleanupConsumer(task: ThumbnailBrokerTask, consumerId: number): void {
    const consumer = task.consumers.get(consumerId);
    if (!consumer) {
      return;
    }

    if (consumer.signal && consumer.abortHandler) {
      consumer.signal.removeEventListener('abort', consumer.abortHandler);
    }

    task.consumers.delete(consumerId);

    if (task.consumers.size !== 0) {
      return;
    }

    if (!task.started) {
      this.removeQueuedTask(task);
      this.tasksByCacheKey.delete(task.cacheKey);
      task.reject(new RequestAbortError());
      return;
    }

    this.cancelActiveTask(task);
  }

  private cancelActiveTask(task: ThumbnailBrokerTask): void {
    const requestId = task.requestId;
    if (requestId === null) {
      return;
    }

    this.requestIdToTask.delete(requestId);
    this.tasksByCacheKey.delete(task.cacheKey);
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    this.abortedCount += 1;

    const worker = task.workerId
      ? (this.workers.find((candidate) => candidate.id === task.workerId) ?? null)
      : null;
    if (worker?.child) {
      try {
        worker.child.postMessage({
          requestId,
          type: 'cancel-thumbnail',
        });
      } catch {
        // Ignore worker cancellation send errors.
      }
      worker.activeRequestId = null;
    }

    task.requestId = null;
    task.workerId = null;
    task.reject(new RequestAbortError());
    this.pumpQueue(task.job.kind);
  }
}
