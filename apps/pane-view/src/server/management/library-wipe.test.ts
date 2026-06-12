import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  insertMock: vi.fn(),
  processMaintenanceJob: vi.fn(),
  transactionMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../auth/api-token", () => ({
  assertSyncApiTokenFromBody: vi.fn(),
}));

vi.mock("./guards", () => ({
  assertNoActiveSyncRun: vi.fn(),
  readActiveCleanupJob: vi.fn(),
}));

vi.mock("./cleanup-worker", () => ({
  processMaintenanceJob: mocks.processMaintenanceJob,
}));

vi.mock("../db", () => ({
  db: {
    delete: mocks.deleteMock,
    insert: mocks.insertMock,
    transaction: mocks.transactionMock,
    update: mocks.updateMock,
  },
}));

import { assertSyncApiTokenFromBody } from "../auth/api-token";
import { readActiveCleanupJob } from "./guards";
import { scheduleLibraryWipe } from "./library-wipe";

describe("scheduleLibraryWipe", () => {
  beforeEach(() => {
    vi.mocked(assertSyncApiTokenFromBody).mockReset();
    vi.mocked(readActiveCleanupJob).mockReset();
    mocks.transactionMock.mockReset();
    mocks.insertMock.mockReset();
    mocks.processMaintenanceJob.mockReset();

    vi.mocked(readActiveCleanupJob).mockResolvedValue(null);
    mocks.transactionMock.mockImplementation(async (callback) =>
      callback({
        delete: mocks.deleteMock,
        update: mocks.updateMock,
      }),
    );
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

  it("schedules a cleanup job without waiting for storage deletion", async () => {
    const result = await scheduleLibraryWipe({
      confirmation: "WIPE LIBRARY",
      syncToken: "good-token",
    });

    expect(result).toEqual({ jobId: "job-1", phase: "scheduled" });
    expect(mocks.processMaintenanceJob).toHaveBeenCalledWith("job-1");
  });
});
