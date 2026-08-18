import { beforeEach, describe, expect, it, vi } from "vitest";

import { maintenanceJobs } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { initialProgressFor, type MaintenanceJobType } from "./maintenance-progress";
import {
  CLEANUP_IN_PROGRESS_MESSAGE,
  type MaintenanceJobDescriptor,
  type MaintenanceSchedulerDependencies,
  type MaintenanceTransaction,
  scheduleMaintenanceJob,
} from "./maintenance-scheduler";

/**
 * The scheduling prologue exists once, in scheduleMaintenanceJob. These tests
 * pin its order and its outcomes for every job type against a real scheduling
 * transaction; the descriptors' own probes and prepare steps are covered
 * against executed SQL in maintenance-descriptors.test.ts.
 */

const testDatabase = testDatabaseForSuite();

const TYPES: MaintenanceJobType[] = [
  "library_hard_wipe",
  "soft_deleted_purge",
  "shutter_source_purge",
];

/** What the prologue did, in the order it did it, and on which transaction. */
interface RecordedPrologue {
  calls: string[];
  scheduled: string[];
  transactionSettled: boolean;
  transactions: MaintenanceTransaction[];
}

function recorded(): RecordedPrologue {
  return { calls: [], scheduled: [], transactionSettled: false, transactions: [] };
}

function dependencies(
  log: RecordedPrologue,
  activeCleanupJob: { id: string } | null = null,
): MaintenanceSchedulerDependencies {
  return {
    acquireLibraryMutationStartupLock: async (tx) => {
      log.calls.push("lock");
      log.transactions.push(tx);
    },
    assertNoActiveSyncRun: async (tx) => {
      log.calls.push("sync-guard");
      log.transactions.push(tx);
    },
    database: {
      async transaction(work) {
        const result = await testDatabase().db.transaction(work);
        log.transactionSettled = true;
        return result;
      },
    },
    processMaintenanceJob: (jobId) => {
      log.calls.push(log.transactionSettled ? "worker-after-commit" : "worker-inside-tx");
      log.scheduled.push(jobId);
    },
    readActiveCleanupJob: async (tx) => {
      log.calls.push("cleanup-guard");
      log.transactions.push(tx);
      return activeCleanupJob;
    },
  };
}

/** A scheduler whose transaction never starts, for the driver-error mapping. */
function failingDependencies(
  log: RecordedPrologue,
  error: Error,
): MaintenanceSchedulerDependencies {
  return {
    ...dependencies(log),
    database: {
      transaction: () => Promise.reject(error),
    },
  };
}

function descriptor(
  type: MaintenanceJobType,
  overrides: Partial<MaintenanceJobDescriptor> = {},
  log?: RecordedPrologue,
): MaintenanceJobDescriptor {
  return {
    probe: vi.fn(async () => {
      log?.calls.push("probe");
      return true;
    }),
    type,
    ...overrides,
  };
}

async function readJobs() {
  return testDatabase().db.select().from(maintenanceJobs);
}

describe("scheduleMaintenanceJob", () => {
  beforeEach(async () => {
    await testDatabase().db.delete(maintenanceJobs);
  });

  it.each(
    TYPES,
  )("%s: lock, sync guard, cleanup guard, probe, insert, then the worker after commit", async (type) => {
    const log = recorded();

    const result = await scheduleMaintenanceJob(descriptor(type, {}, log), dependencies(log));

    const [job] = await readJobs();
    expect(result).toEqual({ jobId: job?.id, phase: "scheduled" });
    expect(log.calls).toEqual([
      "lock",
      "sync-guard",
      "cleanup-guard",
      "probe",
      "worker-after-commit",
    ]);
    // Lock and both guards ran on the one scheduling transaction.
    const [lockTx] = log.transactions;
    expect(lockTx).toBeDefined();
    expect(log.transactions).toEqual([lockTx, lockTx, lockTx]);
    expect(job).toMatchObject({
      progress: initialProgressFor(type),
      status: "pending",
      type,
    });
    expect(log.scheduled).toEqual([job?.id]);
  });

  it("runs prepare inside the transaction after the guards and before the probe", async () => {
    const log = recorded();
    const transactions: MaintenanceTransaction[] = [];
    const prepare = vi.fn(async (tx: MaintenanceTransaction) => {
      log.calls.push("prepare");
      transactions.push(tx);
    });

    await scheduleMaintenanceJob(
      descriptor("library_hard_wipe", { prepare }, log),
      dependencies(log),
    );

    expect(log.calls.slice(0, 5)).toEqual([
      "lock",
      "sync-guard",
      "cleanup-guard",
      "prepare",
      "probe",
    ]);
    expect(transactions).toEqual([log.transactions[0]]);
  });

  it("aborts before the probe when a sync run is active", async () => {
    const log = recorded();
    const deps = dependencies(log);
    const spec = descriptor("soft_deleted_purge", {}, log);

    await expect(
      scheduleMaintenanceJob(spec, {
        ...deps,
        assertNoActiveSyncRun: async () => {
          log.calls.push("sync-guard");
          throw new Error("A sync run is currently active");
        },
      }),
    ).rejects.toThrow("sync run is currently active");

    expect(spec.probe).not.toHaveBeenCalled();
    expect(log.calls).toEqual(["lock", "sync-guard"]);
    expect(log.scheduled).toEqual([]);
    expect(await readJobs()).toEqual([]);
  });

  it("aborts before the probe when a cleanup job is active", async () => {
    const log = recorded();
    const spec = descriptor("shutter_source_purge", {}, log);

    await expect(scheduleMaintenanceJob(spec, dependencies(log, { id: "other" }))).rejects.toThrow(
      CLEANUP_IN_PROGRESS_MESSAGE,
    );

    expect(spec.probe).not.toHaveBeenCalled();
    expect(log.calls).toEqual(["lock", "sync-guard", "cleanup-guard"]);
    expect(await readJobs()).toEqual([]);
  });

  it("returns empty and inserts nothing when the probe finds no work", async () => {
    const log = recorded();
    const spec = descriptor("soft_deleted_purge", { probe: vi.fn(async () => false) }, log);

    await expect(scheduleMaintenanceJob(spec, dependencies(log))).resolves.toEqual({
      jobId: null,
      phase: "empty",
    });

    expect(await readJobs()).toEqual([]);
    expect(log.scheduled).toEqual([]);
  });

  it.each(
    TYPES,
  )("%s: maps an active-job unique violation to the in-progress error", async (type) => {
    const log = recorded();
    const violation = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "maintenance_jobs_active_type_unique",
    });

    await expect(
      scheduleMaintenanceJob(descriptor(type, {}, log), failingDependencies(log, violation)),
    ).rejects.toThrow(CLEANUP_IN_PROGRESS_MESSAGE);
    expect(log.scheduled).toEqual([]);
  });

  it("maps the real unique violation raised by a concurrent active job", async () => {
    const log = recorded();
    await testDatabase()
      .db.insert(maintenanceJobs)
      .values({
        progress: initialProgressFor("soft_deleted_purge"),
        status: "running",
        type: "soft_deleted_purge",
      });

    // The guard is stubbed out, so only the partial unique index stops the insert.
    await expect(
      scheduleMaintenanceJob(descriptor("soft_deleted_purge", {}, log), dependencies(log)),
    ).rejects.toThrow(CLEANUP_IN_PROGRESS_MESSAGE);
    expect(log.scheduled).toEqual([]);
  });

  it("recognises the violation when the driver error is wrapped as the cause", async () => {
    const log = recorded();
    const wrapped = new Error("Failed query", {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint: "maintenance_jobs_active_hard_wipe_unique",
      }),
    });

    await expect(
      scheduleMaintenanceJob(
        descriptor("library_hard_wipe", {}, log),
        failingDependencies(log, wrapped),
      ),
    ).rejects.toThrow(CLEANUP_IN_PROGRESS_MESSAGE);
  });

  it("rethrows a unique violation on another constraint unchanged", async () => {
    const log = recorded();
    const violation = Object.assign(new Error("duplicate key on shutter_source_cleanup_pkey"), {
      code: "23505",
      constraint: "shutter_source_cleanup_pkey",
    });

    await expect(
      scheduleMaintenanceJob(
        descriptor("shutter_source_purge", {}, log),
        failingDependencies(log, violation),
      ),
    ).rejects.toThrow("shutter_source_cleanup_pkey");
  });

  it("rethrows other transaction failures unchanged", async () => {
    const log = recorded();

    await expect(
      scheduleMaintenanceJob(
        descriptor("soft_deleted_purge", {}, log),
        failingDependencies(log, new Error("connection lost")),
      ),
    ).rejects.toThrow("connection lost");
  });
});
