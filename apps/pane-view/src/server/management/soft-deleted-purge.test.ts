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
  db: {
    transaction: mocks.transactionMock,
  },
}));

vi.mock("../db/library-coordination-lock", () => ({
  acquireLibraryMutationStartupLock: vi.fn(async () => undefined),
}));

vi.mock("./guards", () => ({
  assertNoActiveSyncRun: vi.fn(async () => undefined),
  readActiveCleanupJob: vi.fn(async () => null),
}));

import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { scheduleSoftDeletedPurge } from "./soft-deleted-purge";

describe("scheduleSoftDeletedPurge", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const tx = {
      insert: mocks.insertMock,
      select: mocks.selectMock,
    };
    mocks.transactionMock.mockImplementation(async (callback) => callback(tx));
    mocks.insertMock.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "job-1" }]),
      }),
    });
  });

  it("does nothing when there are no soft-deleted entries", async () => {
    mocks.selectMock.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    });

    await expect(scheduleSoftDeletedPurge()).resolves.toEqual({ jobId: null, phase: "empty" });
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.processMaintenanceJob).not.toHaveBeenCalled();
  });

  it("schedules cleanup under the library mutation lock", async () => {
    mocks.selectMock.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: "entry-1" }]),
        }),
      }),
    });

    await expect(scheduleSoftDeletedPurge()).resolves.toEqual({
      jobId: "job-1",
      phase: "scheduled",
    });
    expect(acquireLibraryMutationStartupLock).toHaveBeenCalledOnce();
    expect(mocks.processMaintenanceJob).toHaveBeenCalledWith("job-1");
  });
});
