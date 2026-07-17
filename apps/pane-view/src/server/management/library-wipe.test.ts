import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  executeMock: vi.fn(),
  insertMock: vi.fn(),
  processMaintenanceJob: vi.fn(),
  selectMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../auth/api-token", () => ({
  assertSyncApiTokenFromBody: vi.fn(),
}));

vi.mock("./cleanup-worker", () => ({
  processMaintenanceJob: mocks.processMaintenanceJob,
}));

vi.mock("../db", () => ({
  db: {
    delete: mocks.deleteMock,
    insert: mocks.insertMock,
    select: mocks.selectMock,
    transaction: mocks.transactionMock,
    update: mocks.updateMock,
  },
}));

vi.mock("../db/library-coordination-lock", () => ({
  acquireLibraryMutationStartupLock: vi.fn(async () => undefined),
}));

import { assertSyncApiTokenFromBody } from "../auth/api-token";
import { acquireLibraryMutationStartupLock } from "../db/library-coordination-lock";
import { scheduleLibraryWipe } from "./library-wipe";

describe("scheduleLibraryWipe", () => {
  beforeEach(() => {
    vi.mocked(assertSyncApiTokenFromBody).mockReset();
    vi.mocked(acquireLibraryMutationStartupLock).mockClear();
    mocks.transactionMock.mockReset();
    mocks.insertMock.mockReset();
    mocks.selectMock.mockReset();
    mocks.processMaintenanceJob.mockReset();

    const tx = {
      delete: mocks.deleteMock,
      execute: mocks.executeMock,
      insert: mocks.insertMock,
      select: mocks.selectMock,
      update: mocks.updateMock,
    };

    mocks.transactionMock.mockImplementation(async (callback) => callback(tx));
    mocks.updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    mocks.deleteMock.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    mocks.insertMock.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "job-1" }]),
      }),
    });

    // assertNoActiveSyncRun + readActiveCleanupJob via tx.select
    const syncSelect = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    };
    const cleanupSelect = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    mocks.selectMock.mockReturnValueOnce(syncSelect).mockReturnValueOnce(cleanupSelect);
  });

  it("requires the wipe confirmation phrase", async () => {
    await expect(
      scheduleLibraryWipe({
        confirmation: "nope",
        syncToken: "token",
      }),
    ).rejects.toThrow('Type "WIPE LIBRARY"');
  });

  it("rejects invalid sync tokens", async () => {
    vi.mocked(assertSyncApiTokenFromBody).mockImplementation(() => {
      throw new Error("Invalid sync token.");
    });

    await expect(
      scheduleLibraryWipe({
        confirmation: "WIPE LIBRARY",
        syncToken: "bad",
      }),
    ).rejects.toThrow("Invalid sync token.");
  });

  it("schedules a cleanup job atomically after acquiring the coordination lock", async () => {
    const result = await scheduleLibraryWipe({
      confirmation: "WIPE LIBRARY",
      syncToken: "good-token",
    });

    expect(result).toEqual({ jobId: "job-1", phase: "scheduled" });
    expect(acquireLibraryMutationStartupLock).toHaveBeenCalledOnce();
    expect(mocks.insertMock).toHaveBeenCalled();
    expect(mocks.processMaintenanceJob).toHaveBeenCalledWith("job-1");
  });
});
