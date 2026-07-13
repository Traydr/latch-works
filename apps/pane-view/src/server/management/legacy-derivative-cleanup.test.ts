import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  limit: vi.fn(),
  process: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../db", () => ({
  db: { insert: mocks.insert, select: mocks.select },
}));
vi.mock("./cleanup-worker", () => ({ processMaintenanceJob: mocks.process }));

import { scheduleLegacyDerivativeCleanup } from "./legacy-derivative-cleanup";

describe("scheduleLegacyDerivativeCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mocks.limit.mockResolvedValue([]) })),
      })),
    });
    mocks.insert.mockReturnValue({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "job-1" }]) })),
    });
  });

  it("requires the exact confirmation phrase", async () => {
    await expect(scheduleLegacyDerivativeCleanup({ confirmation: "DELETE" })).rejects.toThrow(
      "DELETE LEGACY DERIVATIVES",
    );
  });

  it("schedules a resumable cleanup job", async () => {
    await expect(
      scheduleLegacyDerivativeCleanup({ confirmation: "DELETE LEGACY DERIVATIVES" }),
    ).resolves.toEqual({ jobId: "job-1" });
    expect(mocks.process).toHaveBeenCalledWith("job-1");
  });
});
