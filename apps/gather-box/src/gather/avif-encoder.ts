import { throwIfAborted, toError } from "./errors";
import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-worker-messages";

interface PendingEncode {
  resolve(buffer: ArrayBuffer): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export class AvifEncoderClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEncode>();

  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(chrome.runtime.getURL("workers/avif-encoder.js"), { type: "module" })
  ) {}

  encode(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
    throwIfAborted(signal);
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const worker = this.getWorker();

    return new Promise<ArrayBuffer>((resolve, reject) => {
      const abort = () => this.stop(new DOMException("The operation was aborted.", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", abort)
      });

      try {
        const request: AvifWorkerRequest = { id, blob };
        worker.postMessage(request);
      } catch (error) {
        this.rejectRequest(id, toError(error));
      }
    });
  }

  dispose(): void {
    this.stop(new Error("The AVIF encoder was disposed."));
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.createWorker();
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleError);
    this.worker = worker;
    return worker;
  }

  private readonly handleMessage = (event: MessageEvent<AvifWorkerResponse>): void => {
    const response = event.data;
    const request = this.pending.get(response.id);
    if (!request) {
      return;
    }
    this.pending.delete(response.id);
    request.removeAbortListener();
    if (response.ok) {
      request.resolve(response.buffer);
    } else {
      request.reject(new Error(response.message));
    }
  };

  private readonly handleError = (event: ErrorEvent): void => {
    this.stop(new Error(event.message || "The AVIF encoder worker failed."));
  };

  private rejectRequest(id: number, error: Error): void {
    const request = this.pending.get(id);
    if (!request) {
      return;
    }
    this.pending.delete(id);
    request.removeAbortListener();
    request.reject(error);
  }

  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.removeEventListener("message", this.handleMessage);
      worker.removeEventListener("error", this.handleError);
      worker.terminate();
    }
    for (const id of Array.from(this.pending.keys())) {
      this.rejectRequest(id, error);
    }
  }
}

const client = new AvifEncoderClient();

export function encodeStillAsAvif(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  return client.encode(blob, signal);
}
