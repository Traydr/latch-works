import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limitMock: vi.fn(),
  selectMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("./sync-run-control", () => ({
  listRunningSyncRuns: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    select: mocks.selectMock,
  },
}));

import { listRunningSyncRuns } from "./sync-run-control";
import { assertNoActiveCleanupJob, assertNoActiveSyncRun } from "./guards";

describe("management guards", () => {
  beforeEach(() => {
    vi.mocked(listRunningSyncRuns).mockReset();
    mocks.selectMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.limitMock.mockReset();

    mocks.selectMock.mockReturnValue({
      from: vi.fn(() => ({
        where: mocks.whereMock.mockReturnValue({
          limit: mocks.limitMock,
        }),
      })),
    });
  });

  it("blocks destructive ops when a sync run is active", async () => {
    vi.mocked(listRunningSyncRuns).mockResolvedValue([
      {
        id: "run-1",
        sourceRoot: "/archive",
        startedAt: "2026-06-12T00:00:00.000Z",
      },
    ]);

    await expect(assertNoActiveSyncRun()).rejects.toThrow("sync run is currently active");
  });

  it("blocks sync starts when a cleanup job is active", async () => {
    mocks.limitMock.mockResolvedValueOnce([
      {
        errorCount: 0,
        id: "job-1",
        phase: "s3_derivatives",
        processedCount: 0,
        status: "running",
      },
    ]);

    await expect(assertNoActiveCleanupJob()).rejects.toThrow("cleanup job is still running");
  });
});
