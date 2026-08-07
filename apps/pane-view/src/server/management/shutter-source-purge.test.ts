import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertMock: vi.fn(),
  processMaintenanceJob: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("./cleanup-worker", () => ({
  processMaintenanceJob: mocks.processMaintenanceJob,
}));

vi.mock("../db", () => ({
  db: { transaction: mocks.transactionMock },
}));

vi.mock("../db/library-coordination-lock", () => ({
  acquireLibraryMutationStartupLock: vi.fn(async () => undefined),
}));

vi.mock("./guards", () => ({
  assertNoActiveSyncRun: vi.fn(async () => undefined),
  readActiveCleanupJob: vi.fn(async () => null),
}));

import { scheduleShutterSourcePurge } from "./shutter-source-purge";

function selectResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  };
}

describe("scheduleShutterSourcePurge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionMock.mockImplementation(async (callback) =>
      callback({ insert: mocks.insertMock, select: mocks.selectMock }),
    );
    mocks.insertMock.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "job-1" }]),
      }),
    });
  });

  it("schedules a standalone job for a queued Shutter source", async () => {
    mocks.selectMock.mockReturnValue(selectResult([{ sha256: "source-1" }]));

    await expect(scheduleShutterSourcePurge()).resolves.toEqual({
      jobId: "job-1",
      phase: "scheduled",
    });
    expect(mocks.processMaintenanceJob).toHaveBeenCalledWith("job-1");
  });

  it("does nothing when no queued or soft-deleted source exists", async () => {
    mocks.selectMock.mockReturnValue(selectResult([]));

    await expect(scheduleShutterSourcePurge()).resolves.toEqual({
      jobId: null,
      phase: "empty",
    });
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.processMaintenanceJob).not.toHaveBeenCalled();
  });
});
