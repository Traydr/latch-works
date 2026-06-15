import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returningMock: vi.fn(),
  setMock: vi.fn(),
  updateMock: vi.fn(),
  whereMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    select: vi.fn(),
    update: mocks.updateMock,
  },
}));

import { forceCancelAllRunningSyncRuns, forceCancelSyncRun } from "./sync-run-control";

describe("sync run control", () => {
  beforeEach(() => {
    mocks.updateMock.mockReset();
    mocks.setMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.returningMock.mockReset();

    mocks.updateMock.mockReturnValue({ set: mocks.setMock });
    mocks.setMock.mockReturnValue({ where: mocks.whereMock });
    mocks.whereMock.mockReturnValue({ returning: mocks.returningMock });
  });

  it("cancels a single running sync run", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    const result = await forceCancelSyncRun({ syncRunId: "run-1" });

    expect(result).toEqual({ cancelled: true });
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Manually cancelled from Pane View management.",
        status: "cancelled",
      }),
    );
  });

  it("returns false when the sync run is not running", async () => {
    mocks.returningMock.mockResolvedValue([]);

    const result = await forceCancelSyncRun({ syncRunId: "run-1" });

    expect(result).toEqual({ cancelled: false });
  });

  it("cancels all running sync runs", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }, { id: "run-2" }]);

    const result = await forceCancelAllRunningSyncRuns();

    expect(result).toEqual({ cancelledCount: 2 });
    expect(mocks.updateMock).toHaveBeenCalledTimes(1);
  });
});
