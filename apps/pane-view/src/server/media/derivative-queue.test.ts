import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    insert: mocks.insertMock,
    select: mocks.selectMock,
    update: mocks.updateMock,
  },
}));

import {
  completeDerivativeJob,
  DERIVATIVE_MAX_ATTEMPTS,
  enqueueDerivativeJob,
  failDerivativeJob,
} from "./derivative-queue";

function mockUpdateReturning(returningValue: unknown) {
  const returningMock = vi.fn().mockResolvedValue(returningValue);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
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

function mockInsertReturning(returningValue: unknown) {
  const returningMock = vi.fn().mockResolvedValue(returningValue);
  const onConflictDoNothingMock = vi.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
  mocks.insertMock.mockReturnValue({ values: valuesMock });
  return { onConflictDoNothingMock, returningMock, valuesMock };
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

describe("enqueueDerivativeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a new pending row with queue priority metadata", async () => {
    const priorityAt = new Date("2026-06-16T12:00:00.000Z");
    mockSelect([]);
    const insert = mockInsertReturning([{ mediaObjectId: "obj-1" }]);

    const result = await enqueueDerivativeJob({
      intent: { priorityAt, source: "on-demand", variant: "preview" },
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-960.webp",
      size: 960,
    });

    expect(result).toBe(true);
    expect(insert.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        priorityAt,
        queuePriority: 300,
        queueSource: "on-demand",
        queueVariant: "preview",
        status: "pending",
      }),
    );
  });

  it("promotes an existing pending row when demand priority is higher", async () => {
    const priorityAt = new Date("2026-06-16T12:00:00.000Z");
    mockSelect([
      {
        priorityAt: new Date("2026-06-15T12:00:00.000Z"),
        queuePriority: 0,
        status: "pending",
        updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      },
    ]);
    const update = mockUpdateReturning([{ mediaObjectId: "obj-1" }]);

    const result = await enqueueDerivativeJob({
      intent: { priorityAt, source: "on-demand", variant: "thumbnail" },
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-320.webp",
      size: 320,
    });

    expect(result).toBe(true);
    expect(update.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        priorityAt,
        queuePriority: 200,
        queueSource: "on-demand",
        queueVariant: "thumbnail",
      }),
    );
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it("does not downgrade an existing on-demand pending row during prewarm", async () => {
    mockSelect([
      {
        priorityAt: new Date("2026-06-16T12:00:00.000Z"),
        queuePriority: 200,
        status: "pending",
        updatedAt: new Date("2026-06-16T12:00:00.000Z"),
      },
    ]);

    const result = await enqueueDerivativeJob({
      intent: {
        priorityAt: new Date("2026-06-15T12:00:00.000Z"),
        source: "prewarm",
        variant: "preview",
      },
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-960.webp",
      size: 960,
    });

    expect(result).toBe(false);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it("resets failed rows only for on-demand work", async () => {
    const priorityAt = new Date("2026-06-16T12:00:00.000Z");
    mockSelect([
      {
        priorityAt: new Date("2026-06-15T12:00:00.000Z"),
        queuePriority: 0,
        status: "failed",
        updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      },
    ]);
    const update = mockUpdateReturning([{ mediaObjectId: "obj-1" }]);

    const result = await enqueueDerivativeJob({
      intent: { priorityAt, source: "on-demand", variant: "thumbnail" },
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-320.webp",
      size: 320,
    });

    expect(result).toBe(true);
    expect(update.setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: null,
        nextAttemptAt: null,
        queuePriority: 200,
        status: "pending",
      }),
    );
  });

  it("leaves ready rows untouched", async () => {
    mockSelect([
      {
        priorityAt: new Date("2026-06-15T12:00:00.000Z"),
        queuePriority: 0,
        status: "ready",
        updatedAt: new Date("2026-06-15T12:00:00.000Z"),
      },
    ]);

    const result = await enqueueDerivativeJob({
      intent: { source: "on-demand", variant: "thumbnail" },
      mediaObjectId: "obj-1",
      objectKey: "thumbnails/x-320.webp",
      size: 320,
    });

    expect(result).toBe(false);
    expect(mocks.updateMock).not.toHaveBeenCalled();
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });
});

describe("failDerivativeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reschedules as pending while attempts remain", async () => {
    mockSelect([{ attemptCount: 0 }]);
    mockUpdateReturning([{ mediaObjectId: "obj-1" }]);

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "token-1",
      size: 320,
    });

    expect(result).toEqual({ matched: true, status: "pending" });
  });

  it("marks failed once the attempt budget is exhausted", async () => {
    mockSelect([{ attemptCount: DERIVATIVE_MAX_ATTEMPTS - 1 }]);
    mockUpdateReturning([{ mediaObjectId: "obj-1" }]);

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "token-1",
      size: 320,
    });

    expect(result).toEqual({ matched: true, status: "failed" });
  });

  it("returns unmatched when the lease is lost before the update", async () => {
    mockSelect([{ attemptCount: 0 }]);
    mockUpdateReturning([]);

    const result = await failDerivativeJob({
      error: "boom",
      mediaObjectId: "obj-1",
      processingToken: "token-1",
      size: 320,
    });

    expect(result).toEqual({ matched: false });
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
