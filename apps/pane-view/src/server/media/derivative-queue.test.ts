import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
}));

import {
  completeDerivativeJob,
  DERIVATIVE_MAX_ATTEMPTS,
  failDerivativeJob,
} from "./derivative-queue";

function mockUpdateReturning(returningValue: unknown) {
  const returningMock = vi.fn().mockResolvedValue(returningValue);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  mocks.updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock };
}

function mockUpdateNoReturning() {
  const whereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  mocks.updateMock.mockReturnValue({ set: setMock });
  return { setMock, whereMock };
}

function mockSelect(rows: unknown) {
  const limitMock = vi.fn().mockResolvedValue(rows);
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  mocks.selectMock.mockReturnValue({ from: fromMock });
}

describe("completeDerivativeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when the lease token matches", async () => {
    mockUpdateReturning([{ mediaObjectId: "obj-1" }]);

    const result = await completeDerivativeJob({
      height: 120,
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-320.webp",
      processingToken: "token-1",
      size: 320,
      width: 160,
    });

    expect(result).toBe(true);
  });

  it("returns false when the lease token no longer matches", async () => {
    mockUpdateReturning([]);

    const result = await completeDerivativeJob({
      height: 120,
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-320.webp",
      processingToken: "stale-token",
      size: 320,
      width: 160,
    });

    expect(result).toBe(false);
  });
});

describe("failDerivativeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reschedules as pending while attempts remain", async () => {
    mockSelect([{ attemptCount: 0 }]);
    const { setMock } = mockUpdateNoReturning();

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "token-1",
      size: 320,
    });

    expect(result).toEqual({ matched: true, status: "pending" });
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 1, status: "pending", processingToken: null }),
    );
  });

  it("marks failed once the attempt budget is exhausted", async () => {
    mockSelect([{ attemptCount: DERIVATIVE_MAX_ATTEMPTS - 1 }]);
    const { setMock } = mockUpdateNoReturning();

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "token-1",
      size: 320,
    });

    expect(result).toEqual({ matched: true, status: "failed" });
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", nextAttemptAt: null }),
    );
  });

  it("returns unmatched when no row owns the lease token", async () => {
    mockSelect([]);

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "stale",
      size: 320,
    });

    expect(result).toEqual({ matched: false });
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});
