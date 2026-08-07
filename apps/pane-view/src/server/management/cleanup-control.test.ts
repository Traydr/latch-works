import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  returning: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  where: vi.fn(),
}));

vi.mock("../db", () => ({
  db: { update: mocks.update },
}));

import { cancelMaintenanceJob } from "./cleanup-control";

describe("cancelMaintenanceJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockReturnValue({ set: mocks.set });
    mocks.set.mockReturnValue({ where: mocks.where });
    mocks.where.mockReturnValue({ returning: mocks.returning });
  });

  it("durably cancels an active cleanup job", async () => {
    mocks.returning.mockResolvedValue([{ id: "job-1" }]);

    await expect(cancelMaintenanceJob({ jobId: "job-1" })).resolves.toEqual({
      cancelled: true,
    });
    expect(mocks.set).toHaveBeenCalledWith({
      completedAt: expect.any(Date),
      error: null,
      status: "cancelled",
    });
  });

  it("does not change a terminal or missing job", async () => {
    mocks.returning.mockResolvedValue([]);

    await expect(cancelMaintenanceJob({ jobId: "job-1" })).resolves.toEqual({
      cancelled: false,
    });
  });
});
