import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimJobs: vi.fn(),
  createS3StorageClient: vi.fn(() => ({ bucket: "test", client: {} })),
  generateDerivativeBytes: vi.fn(),
  putStoredObject: vi.fn(),
  reportComplete: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("./env.js", () => ({
  env: {
    MEDIA_OPTIMIZER_PORT: 3200,
    MEDIA_OPTIMIZER_TOKEN: "test-token-0123456789",
    OPTIMIZER_BATCH_LIMIT: 5,
    OPTIMIZER_CLAIM_CHUNK: 2,
    OPTIMIZER_MAX_RUNTIME_MS: 50_000,
    PANE_VIEW_INTERNAL_URL: "http://127.0.0.1:3000",
    S3_ACCESS_KEY_ID: "test",
    S3_BUCKET: "test",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_REGION: "auto",
    S3_SECRET_ACCESS_KEY: "test",
  },
}));

vi.mock("./pane-view-client.js", () => ({
  claimJobs: mocks.claimJobs,
  reportComplete: mocks.reportComplete,
  reportFailure: mocks.reportFailure,
}));

vi.mock("@latch-works/media-derivatives", () => ({
  generateDerivativeBytes: mocks.generateDerivativeBytes,
}));

vi.mock("@latch-works/media-storage", () => ({
  createS3StorageClient: mocks.createS3StorageClient,
  putStoredObject: mocks.putStoredObject,
}));

import { processBatch } from "./processor.js";

function makeJob(index: number) {
  return {
    attemptCount: 0,
    extension: "jpg",
    mediaObjectId: `obj-${index}`,
    mediaType: "image" as const,
    objectKey: `thumbnails/obj-${index}-320.webp`,
    originalObjectKey: `originals/obj-${index}.jpg`,
    sha256: "a".repeat(64),
    size: 320,
  };
}

function claimResponseOfLength(limit: number) {
  return {
    jobs: Array.from({ length: limit }, (_, index) => makeJob(index)),
    processingToken: "token-1",
  };
}

describe("processBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateDerivativeBytes.mockResolvedValue({
      bytes: Buffer.from("webp"),
      height: 200,
      width: 240,
    });
    mocks.putStoredObject.mockResolvedValue(undefined);
    mocks.reportComplete.mockResolvedValue(undefined);
    mocks.reportFailure.mockResolvedValue(undefined);
  });

  it("generates, uploads, and reports completion for each claimed job", async () => {
    mocks.claimJobs.mockResolvedValueOnce(claimResponseOfLength(1)).mockResolvedValue({
      jobs: [],
      processingToken: "token-empty",
    });

    const result = await processBatch();

    expect(mocks.generateDerivativeBytes).toHaveBeenCalledTimes(1);
    expect(mocks.putStoredObject).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/webp", key: "thumbnails/obj-0-320.webp" }),
    );
    expect(mocks.reportComplete).toHaveBeenCalledWith(
      expect.objectContaining({ height: 200, processingToken: "token-1", width: 240 }),
    );
    expect(result).toEqual(expect.objectContaining({ failed: 0, processed: 1, succeeded: 1 }));
  });

  it("reports failure and continues when generation throws", async () => {
    mocks.generateDerivativeBytes.mockRejectedValueOnce(new Error("boom"));
    mocks.claimJobs.mockResolvedValueOnce(claimResponseOfLength(1)).mockResolvedValue({
      jobs: [],
      processingToken: "token-empty",
    });

    const result = await processBatch();

    expect(mocks.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "boom",
        mediaObjectId: "obj-0",
        processingToken: "token-1",
      }),
    );
    expect(mocks.reportComplete).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ failed: 1, processed: 1, succeeded: 0 }));
  });

  it("honors the batch limit even when the queue keeps returning work", async () => {
    mocks.claimJobs.mockImplementation((limit: number) =>
      Promise.resolve(claimResponseOfLength(limit)),
    );

    const result = await processBatch();

    expect(result.processed).toBe(5);
    expect(mocks.generateDerivativeBytes).toHaveBeenCalledTimes(5);
  });

  it("stops claiming when the queue is empty", async () => {
    mocks.claimJobs.mockResolvedValue({ jobs: [], processingToken: "token-empty" });

    const result = await processBatch();

    expect(result.processed).toBe(0);
    expect(mocks.claimJobs).toHaveBeenCalledTimes(1);
  });
});
