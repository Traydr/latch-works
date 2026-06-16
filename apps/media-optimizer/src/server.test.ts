import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processBatch: vi.fn(),
}));

vi.mock("./env.js", () => ({
  env: {
    MEDIA_OPTIMIZER_TOKEN: "test-token-0123456789",
  },
}));

vi.mock("./processor.js", () => ({
  processBatch: mocks.processBatch,
}));

import { createServer } from "./server.js";

function authorizedRequest(app: ReturnType<typeof createServer>) {
  return app.request("/internal/optimizer/process", {
    headers: { authorization: "Bearer test-token-0123456789" },
    method: "POST",
  });
}

describe("media optimizer server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts processing in the background and returns immediately", async () => {
    mocks.processBatch.mockResolvedValue({
      durationMs: 10,
      failed: 0,
      processed: 1,
      succeeded: 1,
    });
    const app = createServer();

    const response = await authorizedRequest(app);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "started" });
    expect(mocks.processBatch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(console.log).toHaveBeenCalled();
    });
  });

  it("reports busy without starting overlapping batches", async () => {
    let finishProcessing: () => void = () => undefined;
    mocks.processBatch.mockReturnValue(
      new Promise((resolve) => {
        finishProcessing = () => resolve({ durationMs: 10, failed: 0, processed: 1, succeeded: 1 });
      }),
    );
    const app = createServer();

    const first = await authorizedRequest(app);
    const second = await authorizedRequest(app);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ status: "busy" });
    expect(mocks.processBatch).toHaveBeenCalledTimes(1);

    finishProcessing();
    await vi.waitFor(() => {
      expect(console.log).toHaveBeenCalled();
    });
  });
});
