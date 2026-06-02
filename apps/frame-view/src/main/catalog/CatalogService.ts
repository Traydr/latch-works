import path from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { utilityProcess } from 'electron';

import {
  type CatalogWorkerRequest,
  isCatalogWorkerEvent,
  isCatalogWorkerResponse,
} from '../../shared/catalog';
import type { MediaIndexStats, ScanEvent, ScanOptions } from '../../shared/types';
import { WorkerError } from '../errors';

type MessageListener = (message: unknown) => void;
type ExitListener = (code: number | null) => void;
type ErrorListener = (type: 'FatalError', location: string, report: string) => void;

export interface CatalogChildProcessLike {
  kill(): boolean;
  on(event: 'message', listener: MessageListener): this;
  on(event: 'exit', listener: ExitListener): this;
  on(event: 'error', listener: ErrorListener): this;
  postMessage(message: CatalogWorkerRequest): void;
}

type CatalogChildFactory = (modulePath: string, args: string[]) => CatalogChildProcessLike;

type CatalogWorkerRequestPayload =
  | {
      type: 'start-scan';
      options: ScanOptions;
    }
  | {
      type: 'cancel-scan';
    }
  | {
      type: 'get-index-stats';
    }
  | {
      type: 'clear-index';
    };

interface PendingRequest<T> {
  resolve: (value: ResultType<T, WorkerError>) => void;
}

export class CatalogService {
  private child: CatalogChildProcessLike | null = null;
  private nextRequestId = 1;
  private activeScanRunId: number | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest<unknown>>();

  constructor(
    private readonly userDataPath: string,
    private readonly emitScanEvent: (event: ScanEvent) => void,
    private readonly childFactory: CatalogChildFactory = (modulePath, args) =>
      utilityProcess.fork(modulePath, args),
  ) {}

  async startScan(options: ScanOptions): Promise<ResultType<void, WorkerError>> {
    return this.sendRequest<void>({
      type: 'start-scan',
      options,
    });
  }

  async cancelScan(): Promise<ResultType<void, WorkerError>> {
    return this.sendRequest<void>({
      type: 'cancel-scan',
    });
  }

  async getMediaIndexStats(): Promise<ResultType<MediaIndexStats, WorkerError>> {
    return this.sendRequest<MediaIndexStats>({
      type: 'get-index-stats',
    });
  }

  async clearIndex(): Promise<ResultType<void, WorkerError>> {
    return this.sendRequest<void>({
      type: 'clear-index',
    });
  }

  shutdown(): void {
    this.rejectPendingRequests(
      new WorkerError({
        worker: 'catalog',
        operation: 'shutdown',
        message: 'Catalog worker shut down',
      }),
    );

    if (!this.child) {
      return;
    }

    this.child.kill();
    this.child = null;
  }

  private ensureChild(): CatalogChildProcessLike {
    if (this.child) {
      return this.child;
    }

    const workerModulePath = path.join(__dirname, 'catalog.worker.js');
    const child = this.childFactory(workerModulePath, [this.userDataPath]);

    child.on('message', (message) => {
      this.handleChildMessage(message);
    });

    child.on('exit', () => {
      this.handleChildExit();
    });

    child.on('error', (_type, location) => {
      this.handleChildExit(`Catalog worker crashed at ${location}`);
    });

    this.child = child;
    return child;
  }

  private handleChildMessage(message: unknown): void {
    if (isCatalogWorkerEvent(message)) {
      const scanEvent = message.event;

      if (scanEvent.type === 'reset') {
        this.activeScanRunId = scanEvent.runId;
      } else if (scanEvent.type === 'done' || scanEvent.type === 'cancelled') {
        if (this.activeScanRunId === scanEvent.runId) {
          this.activeScanRunId = null;
        }
      }

      this.emitScanEvent(scanEvent);
      return;
    }

    if (!isCatalogWorkerResponse(message)) {
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.requestId);

    if ('error' in message) {
      pending.resolve(
        Result.err(
          new WorkerError({
            worker: 'catalog',
            operation: 'worker-response',
            message: message.error,
          }),
        ),
      );
      return;
    }

    pending.resolve(Result.ok(message.result as never));
  }

  private handleChildExit(message = 'Catalog worker exited unexpectedly'): void {
    const hadActiveScan = this.activeScanRunId !== null;

    this.child = null;
    this.rejectPendingRequests(
      new WorkerError({
        worker: 'catalog',
        operation: 'worker-exit',
        message,
      }),
    );

    if (!hadActiveScan || this.activeScanRunId === null) {
      return;
    }

    const runId = this.activeScanRunId;
    this.activeScanRunId = null;
    this.emitScanEvent({ type: 'cancelled', runId });
    this.emitScanEvent({ type: 'error', message });
  }

  private rejectPendingRequests(error: WorkerError): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      pending.resolve(Result.err(error));
    }
  }

  private sendRequest<T>(
    request: CatalogWorkerRequestPayload,
  ): Promise<ResultType<T, WorkerError>> {
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    const payload = { ...request, requestId } as CatalogWorkerRequest;

    return new Promise<ResultType<T, WorkerError>>((resolve) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as PendingRequest<unknown>['resolve'],
      });

      try {
        child.postMessage(payload);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        resolve(
          Result.err(
            new WorkerError({
              worker: 'catalog',
              operation: 'send-request',
              message:
                error instanceof Error ? error.message : 'Failed to send catalog worker request',
              cause: error,
            }),
          ),
        );
      }
    });
  }
}
