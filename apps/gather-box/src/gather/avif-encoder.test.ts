import { describe, expect, it, vi } from "vitest";
import { AvifEncoderClient } from "./avif-encoder";
import type { AvifWorkerResponse } from "./avif-worker-messages";

describe("AVIF encoder worker client", () => {
  it("resolves a completed worker response", async () => {
    const worker = new FakeWorker();
    const client = new AvifEncoderClient(() => worker as unknown as Worker);

    const pending = client.encode(new Blob(["image"]));
    const request = worker.postMessage.mock.calls[0]?.[0] as { id: number };
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    worker.emitMessage({ id: request.id, ok: true, buffer });

    await expect(pending).resolves.toBe(buffer);
    expect(worker.terminate).not.toHaveBeenCalled();
    client.dispose();
  });

  it("terminates the blocking worker when the signal is aborted", async () => {
    const worker = new FakeWorker();
    const client = new AvifEncoderClient(() => worker as unknown as Worker);
    const controller = new AbortController();

    const pending = client.encode(new Blob(["image"]), controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

class FakeWorker {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  private messageListener: ((event: MessageEvent<AvifWorkerResponse>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") {
      this.messageListener = listener as (event: MessageEvent<AvifWorkerResponse>) => void;
    } else if (type === "error") {
      this.errorListener = listener as (event: ErrorEvent) => void;
    }
  }

  removeEventListener(type: string): void {
    if (type === "message") {
      this.messageListener = null;
    } else if (type === "error") {
      this.errorListener = null;
    }
  }

  emitMessage(response: AvifWorkerResponse): void {
    this.messageListener?.({ data: response } as MessageEvent<AvifWorkerResponse>);
  }
}
