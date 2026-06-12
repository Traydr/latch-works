import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const updateMock = vi.fn();
  const whereMock = vi.fn();
  const setMock = vi.fn();
  const returningMock = vi.fn();

  return { returningMock, setMock, updateMock, whereMock };
});

vi.mock("../db", () => ({
  db: {
    update: mocks.updateMock,
  },
}));

import { finalizeSyncRun } from "./store";

describe("finalizeSyncRun", () => {
  beforeEach(() => {
    mocks.updateMock.mockReset();
    mocks.whereMock.mockReset();
    mocks.setMock.mockReset();
    mocks.returningMock.mockReset();

    mocks.updateMock.mockReturnValue({ set: mocks.setMock });
    mocks.setMock.mockReturnValue({ where: mocks.whereMock });
    mocks.whereMock.mockReturnValue({ returning: mocks.returningMock });
  });

  it("marks completed runs with final counts", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    const result = await finalizeSyncRun({
      input: {
        counts: { pushed: 2, planned: 2 },
        status: "completed",
        syncRunId: "run-1",
      },
    });

    expect(result).toEqual({ status: "database" });
    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: { pushed: 2, planned: 2 },
        error: null,
        status: "completed",
      }),
    );
  });

  it("marks failed runs with error text", async () => {
    mocks.returningMock.mockResolvedValue([{ id: "run-1" }]);

    await finalizeSyncRun({
      input: {
        counts: { failed: 1, pushed: 0, planned: 1 },
        error: "1 item(s) failed during push",
        status: "failed",
        syncRunId: "run-1",
      },
    });

    expect(mocks.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "1 item(s) failed during push",
        status: "failed",
      }),
    );
  });
});
