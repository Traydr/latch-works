import { throwIfAborted, toError } from "./errors";
import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-worker-messages";

/**
 * The worker surface this client drives, stated as domain callbacks rather than DOM events so a
 * test can supply a faithful in-process double. A terminated worker delivers nothing further,
 * so there is no unsubscribe.
 */
export interface EncoderWorker {
  postMessage(request: AvifWorkerRequest): void;
  terminate(): void;
  onResponse(listener: (response: AvifWorkerResponse) => void): void;
  onFailure(listener: (message: string) => void): void;
}

function createBrowserEncoderWorker(): EncoderWorker {
  const worker = new Worker(chrome.runtime.getURL("workers/avif-encoder.js"), { type: "module" });

  return {
    postMessage: (request) => worker.postMessage(request),
    terminate: () => worker.terminate(),
    onResponse: (listener) =>
      worker.addEventListener("message", (event: MessageEvent<AvifWorkerResponse>) =>
        listener(event.data)
      ),
    onFailure: (listener) =>
      worker.addEventListener("error", (event) =>
        listener(event.message || "The AVIF encoder worker failed.")
      )
  };
}

interface PendingEncode {
  resolve(buffer: ArrayBuffer): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export class AvifEncoderClient {
  private worker: EncoderWorker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEncode>();

  constructor(
    private readonly createWorker: () => EncoderWorker = createBrowserEncoderWorker
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

  private getWorker(): EncoderWorker {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.createWorker();
    worker.onResponse(this.handleResponse);
    worker.onFailure(this.handleFailure);
    this.worker = worker;
    return worker;
  }

  private readonly handleResponse = (response: AvifWorkerResponse): void => {
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

  private readonly handleFailure = (message: string): void => {
    this.stop(new Error(message));
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
    worker?.terminate();
    for (const id of Array.from(this.pending.keys())) {
      this.rejectRequest(id, error);
    }
  }
}

const client = new AvifEncoderClient();

export function encodeStillAsAvif(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  return client.encode(blob, signal);
}
