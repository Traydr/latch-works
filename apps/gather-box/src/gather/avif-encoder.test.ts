import { describe, expect, it, vi } from "vitest";
import { AvifEncoderClient, type EncoderWorker } from "./avif-encoder";
import type { AvifWorkerRequest, AvifWorkerResponse } from "./avif-worker-messages";

describe("AVIF encoder worker client", () => {
  it("resolves a completed worker response", async () => {
    const worker = new FakeEncoderWorker();
    const client = new AvifEncoderClient(() => worker);

    const pending = client.encode(new Blob(["image"]));
    const request = worker.postMessage.mock.calls[0]?.[0];
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    worker.emitResponse({ id: request.id, ok: true, buffer });

    await expect(pending).resolves.toBe(buffer);
    expect(worker.terminate).not.toHaveBeenCalled();
    client.dispose();
  });

  it("terminates the blocking worker when the signal is aborted", async () => {
    const worker = new FakeEncoderWorker();
    const client = new AvifEncoderClient(() => worker);
    const controller = new AbortController();

    const pending = client.encode(new Blob(["image"]), controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

class FakeEncoderWorker implements EncoderWorker {
  readonly postMessage = vi.fn<(request: AvifWorkerRequest) => void>();
  readonly terminate = vi.fn();
  private responseListener: ((response: AvifWorkerResponse) => void) | null = null;
  private failureListener: ((message: string) => void) | null = null;

  onResponse(listener: (response: AvifWorkerResponse) => void): void {
    this.responseListener = listener;
  }

  onFailure(listener: (message: string) => void): void {
    this.failureListener = listener;
  }

  emitResponse(response: AvifWorkerResponse): void {
    this.responseListener?.(response);
  }

  emitFailure(message: string): void {
    this.failureListener?.(message);
  }
}
