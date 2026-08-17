import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduling prologue exists once, in scheduleMaintenanceJob. These tests
 * pin its order and its outcomes for every job type; the descriptors' own
 * probes and prepare steps are covered against executed SQL in
 * maintenance-descriptors.test.ts.
 */

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  assertNoActiveSyncRun: vi.fn(),
  calls: [] as string[],
  insertReturning: vi.fn(),
  processMaintenanceJob: vi.fn(),
  readActiveCleanupJob: vi.fn(),
  transaction: vi.fn(),
  transactionSettled: false,
}));

vi.mock("../db", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../db/library-coordination-lock", () => ({
  acquireLibraryMutationStartupLock: mocks.acquireLock,
}));
vi.mock("./guards", () => ({
  assertNoActiveSyncRun: mocks.assertNoActiveSyncRun,
  readActiveCleanupJob: mocks.readActiveCleanupJob,
}));
vi.mock("./cleanup-worker", () => ({ processMaintenanceJob: mocks.processMaintenanceJob }));

import type { MaintenanceJobType } from "./maintenance-progress";
import { initialProgressFor } from "./maintenance-progress";
import {
  CLEANUP_IN_PROGRESS_MESSAGE,
  type MaintenanceJobDescriptor,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";

const TYPES: MaintenanceJobType[] = [
  "library_hard_wipe",
  "soft_deleted_purge",
  "shutter_source_purge",
];

function descriptor(
  type: MaintenanceJobType,
  overrides: Partial<MaintenanceJobDescriptor> = {},
): MaintenanceJobDescriptor {
  return {
    probe: vi.fn(async () => {
      mocks.calls.push("probe");
      return true;
    }),
    type,
    ...overrides,
  };
}

const tx = {
  insert: vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      mocks.calls.push("insert");
      (tx as { lastInsert?: unknown }).lastInsert = values;
      return { returning: mocks.insertReturning };
    }),
  })),
} as { insert: ReturnType<typeof vi.fn>; lastInsert?: unknown };

describe("scheduleMaintenanceJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.transactionSettled = false;
    tx.lastInsert = undefined;
    mocks.acquireLock.mockImplementation(async () => {
      mocks.calls.push("lock");
    });
    mocks.assertNoActiveSyncRun.mockImplementation(async () => {
      mocks.calls.push("sync-guard");
    });
    mocks.readActiveCleanupJob.mockImplementation(async () => {
      mocks.calls.push("cleanup-guard");
      return null;
    });
    mocks.insertReturning.mockResolvedValue([{ id: "job-1" }]);
    mocks.processMaintenanceJob.mockImplementation(() => {
      mocks.calls.push(mocks.transactionSettled ? "worker-after-commit" : "worker-inside-tx");
    });
    mocks.transaction.mockImplementation(async (callback: (t: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      mocks.transactionSettled = true;
      return result;
    });
  });

  it.each(
    TYPES,
  )("%s: lock, sync guard, cleanup guard, probe, insert, then the worker after commit", async (type) => {
    await expect(scheduleMaintenanceJob(descriptor(type))).resolves.toEqual({
      jobId: "job-1",
      phase: "scheduled",
    });
    expect(mocks.calls).toEqual([
      "lock",
      "sync-guard",
      "cleanup-guard",
      "probe",
      "insert",
      "worker-after-commit",
    ]);
    expect(mocks.acquireLock).toHaveBeenCalledWith(tx);
    expect(mocks.assertNoActiveSyncRun).toHaveBeenCalledWith(tx);
    expect(mocks.readActiveCleanupJob).toHaveBeenCalledWith(tx);
    expect(tx.lastInsert).toEqual({
      progress: initialProgressFor(type),
      status: "pending",
      type,
    });
    expect(mocks.processMaintenanceJob).toHaveBeenCalledWith("job-1");
  });

  it("runs prepare inside the transaction after the guards and before the probe", async () => {
    const prepare = vi.fn(async () => {
      mocks.calls.push("prepare");
    });
    await scheduleMaintenanceJob(descriptor("library_hard_wipe", { prepare }));
    expect(mocks.calls.slice(0, 5)).toEqual([
      "lock",
      "sync-guard",
      "cleanup-guard",
      "prepare",
      "probe",
    ]);
    expect(prepare).toHaveBeenCalledWith(tx);
  });

  it("aborts before the probe when a sync run is active", async () => {
    mocks.assertNoActiveSyncRun.mockImplementationOnce(async () => {
      mocks.calls.push("sync-guard");
      throw new Error("A sync run is currently active");
    });
    const spec = descriptor("soft_deleted_purge");
    await expect(scheduleMaintenanceJob(spec)).rejects.toThrow("sync run is currently active");
    expect(spec.probe).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(["lock", "sync-guard"]);
    expect(mocks.processMaintenanceJob).not.toHaveBeenCalled();
  });

  it("aborts before the probe when a cleanup job is active", async () => {
    mocks.readActiveCleanupJob.mockImplementationOnce(async () => {
      mocks.calls.push("cleanup-guard");
      return { id: "other", phase: "queue_sources", processedCount: 0, status: "running" as const };
    });
    const spec = descriptor("shutter_source_purge");
    await expect(scheduleMaintenanceJob(spec)).rejects.toThrow(CLEANUP_IN_PROGRESS_MESSAGE);
    expect(spec.probe).not.toHaveBeenCalled();
    expect(mocks.calls).toEqual(["lock", "sync-guard", "cleanup-guard"]);
  });

  it("returns empty and inserts nothing when the probe finds no work", async () => {
    const spec = descriptor("soft_deleted_purge", { probe: vi.fn(async () => false) });
    await expect(scheduleMaintenanceJob(spec)).resolves.toEqual({ jobId: null, phase: "empty" });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(mocks.processMaintenanceJob).not.toHaveBeenCalled();
  });

  it.each(TYPES)("%s: maps a unique violation to the in-progress error", async (type) => {
    mocks.transaction.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    await expect(scheduleMaintenanceJob(descriptor(type))).rejects.toThrow(
      CLEANUP_IN_PROGRESS_MESSAGE,
    );
    expect(mocks.processMaintenanceJob).not.toHaveBeenCalled();
  });

  it("rethrows other transaction failures unchanged", async () => {
    mocks.transaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(scheduleMaintenanceJob(descriptor("soft_deleted_purge"))).rejects.toThrow(
      "connection lost",
    );
  });
});
