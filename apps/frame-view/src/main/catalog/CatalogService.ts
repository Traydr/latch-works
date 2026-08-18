import path from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { utilityProcess } from 'electron';

import type { CatalogWorkerRequest } from '../../shared/catalog';
import {
  CatalogWorkerEventSchema,
  CatalogWorkerResponseSchema,
  type JsonValue,
} from '../../shared/contracts';
import type { MediaIndexStats, ScanEvent, ScanOptions } from '../../shared/types';
import { toError, WorkerError } from '../errors';

type MessageListener = (message: JsonValue) => void;
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

/** A worker response either carries index stats or nothing at all. */
type CatalogResponseValue = MediaIndexStats | undefined;

interface PendingRequest {
  resolve: (value: ResultType<CatalogResponseValue, WorkerError>) => void;
}

export class CatalogService {
  private child: CatalogChildProcessLike | null = null;
  private nextRequestId = 1;
  private activeScanRunId: number | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();

  constructor(
    private readonly userDataPath: string,
    private readonly emitScanEvent: (event: ScanEvent) => void,
    private readonly childFactory: CatalogChildFactory = (modulePath, args) =>
      utilityProcess.fork(modulePath, args),
  ) {}

  async startScan(options: ScanOptions): Promise<ResultType<void, WorkerError>> {
    return this.sendAcknowledgedRequest({
      type: 'start-scan',
      options,
    });
  }

  async cancelScan(): Promise<ResultType<void, WorkerError>> {
    return this.sendAcknowledgedRequest({
      type: 'cancel-scan',
    });
  }

  async getMediaIndexStats(): Promise<ResultType<MediaIndexStats, WorkerError>> {
    const response = await this.sendRequest({
      type: 'get-index-stats',
    });
    if (Result.isError(response)) {
      return response;
    }

    if (!response.value) {
      return Result.err(
        new WorkerError({
          worker: 'catalog',
          operation: 'get-index-stats',
          message: 'Catalog worker returned no index stats',
        }),
      );
    }

    return Result.ok(response.value);
  }

  async clearIndex(): Promise<ResultType<void, WorkerError>> {
    return this.sendAcknowledgedRequest({
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

  private handleChildMessage(message: JsonValue): void {
    const workerEvent = CatalogWorkerEventSchema.safeParse(message);
    if (workerEvent.success) {
      const scanEvent = workerEvent.data.event;

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

    const workerResponse = CatalogWorkerResponseSchema.safeParse(message);
    if (!workerResponse.success) {
      return;
    }

    const response = workerResponse.data;
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.requestId);

    if (!response.ok) {
      pending.resolve(
        Result.err(
          new WorkerError({
            worker: 'catalog',
            operation: 'worker-response',
            message: response.error,
          }),
        ),
      );
      return;
    }

    pending.resolve(Result.ok(response.result));
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

  /** Requests whose response carries no value: the worker only acknowledges them. */
  private async sendAcknowledgedRequest(
    request: CatalogWorkerRequestPayload,
  ): Promise<ResultType<void, WorkerError>> {
    const response = await this.sendRequest(request);
    return Result.isError(response) ? response : Result.ok();
  }

  private sendRequest(
    request: CatalogWorkerRequestPayload,
  ): Promise<ResultType<CatalogResponseValue, WorkerError>> {
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    const payload: CatalogWorkerRequest = { ...request, requestId };

    return new Promise<ResultType<CatalogResponseValue, WorkerError>>((resolve) => {
      this.pendingRequests.set(requestId, { resolve });

      try {
        child.postMessage(payload);
      } catch (cause) {
        const error = toError(cause);
        this.pendingRequests.delete(requestId);
        resolve(
          Result.err(
            new WorkerError({
              worker: 'catalog',
              operation: 'send-request',
              message: error.message,
              cause: error,
            }),
          ),
        );
      }
    });
  }
}
