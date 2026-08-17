import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The maintenance worker against executed SQL: progress enters through the
 * parser and a wrong-type phase fails the job instead of advancing it; the
 * retired s3_derivatives phase still resumes a hard wipe; completed jobs are
 * left alone; a throwing batch marks the job failed and frees it to run again.
 */

const harness = vi.hoisted(() => ({
  handle: null as null | {
    client: { exec(sql: string): Promise<unknown> };
    close(): Promise<void>;
  },
}));

vi.mock("../db", async () => {
  const { createTestDatabase } = await import("../library/test-db");
  const handle = await createTestDatabase();
  harness.handle = handle;
  return { db: handle.db };
});
vi.mock("@latch-works/media-storage", () => ({ listStoredObjectsByPrefix: vi.fn() }));
vi.mock("../media/shutter-client", () => ({ purgeShutterSource: vi.fn(async () => undefined) }));
vi.mock("./maintenance-storage", () => ({
  deleteMaintenanceObjects: vi.fn(async (keys: string[]) => ({ deleted: keys.length })),
  getMaintenanceStorageClient: vi.fn(),
}));

import { db } from "../db";
import {
  libraryEntries,
  type MaintenanceJobProgress,
  maintenanceJobs,
  mediaObjects,
} from "../db/schema";
import {
  processMaintenanceJob,
  processMaintenanceJobBatch,
  readCleanupJobStatus,
} from "./cleanup-worker";
import type { MaintenanceJobType } from "./maintenance-progress";
import { deleteMaintenanceObjects } from "./maintenance-storage";

afterAll(async () => {
  await harness.handle?.close();
});

async function reset() {
  await harness.handle?.client.exec(
    "delete from maintenance_jobs; delete from shutter_source_cleanup; delete from library_entries; delete from media_objects;",
  );
  vi.mocked(deleteMaintenanceObjects).mockClear();
}

async function insertJob(
  type: MaintenanceJobType,
  progress: unknown,
  status: "pending" | "running" | "completed" = "running",
): Promise<string> {
  const [job] = await db
    .insert(maintenanceJobs)
    .values({ progress: progress as MaintenanceJobProgress, status, type })
    .returning({ id: maintenanceJobs.id });
  return (job as { id: string }).id;
}

async function readJob(jobId: string) {
  const [job] = await db.select().from(maintenanceJobs).where(eq(maintenanceJobs.id, jobId));
  return job as NonNullable<typeof job>;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("processMaintenanceJobBatch", () => {
  beforeEach(reset);

  it("fails a soft-deleted purge whose phase is the retired hard-wipe phase instead of advancing it", async () => {
    const jobId = await insertJob("soft_deleted_purge", {
      errorCount: 0,
      phase: "s3_derivatives",
      processedCount: 3,
    });
    await expect(processMaintenanceJobBatch(jobId)).resolves.toBe(false);
    const job = await readJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(
      'Unrecognised job progress: phase "s3_derivatives" is not valid for soft_deleted_purge',
    );
    expect(job.progress).toEqual({ errorCount: 0, phase: "s3_derivatives", processedCount: 3 });
    expect(await readCleanupJobStatus({ jobId })).toBeNull();
  });

  it("resumes a hard wipe stored under the retired phase from s3_originals", async () => {
    const jobId = await insertJob("library_hard_wipe", {
      errorCount: 0,
      phase: "s3_derivatives",
      processedCount: 3,
    });
    // No media objects: the s3_originals batch finds nothing and moves to the sweep.
    await expect(processMaintenanceJobBatch(jobId)).resolves.toBe(true);
    const job = await readJob(jobId);
    expect(job.status).toBe("running");
    expect(job.progress).toEqual({
      orphanPrefix: "originals/",
      phase: "s3_orphan_sweep",
      processedCount: 3,
    });
    expect(await readCleanupJobStatus({ jobId })).toMatchObject({
      progress: { phase: "s3_orphan_sweep", processedCount: 3 },
      status: "running",
      type: "library_hard_wipe",
    });
  });

  it.each([
    "library_hard_wipe",
    "soft_deleted_purge",
    "shutter_source_purge",
  ] as MaintenanceJobType[])("%s: a completed phase returns false and leaves the row untouched", async (type) => {
    const jobId = await insertJob(type, { phase: "completed", processedCount: 5 }, "running");
    const before = await readJob(jobId);
    await expect(processMaintenanceJobBatch(jobId)).resolves.toBe(false);
    expect(await readJob(jobId)).toEqual(before);
    const done = await insertJob(type, { phase: "completed", processedCount: 5 }, "completed");
    await expect(processMaintenanceJobBatch(done)).resolves.toBe(false);
    expect(deleteMaintenanceObjects).not.toHaveBeenCalled();
  });

  it("marks a pending job running and drops the retired errorCount as it advances", async () => {
    const jobId = await insertJob(
      "shutter_source_purge",
      { errorCount: 0, phase: "queue_sources", processedCount: 0 },
      "pending",
    );
    await expect(processMaintenanceJobBatch(jobId)).resolves.toBe(true);
    const job = await readJob(jobId);
    expect(job.status).toBe("running");
    expect(job.startedAt).not.toBeNull();
    expect(job.progress).toEqual({ phase: "shutter_sources", processedCount: 0 });
  });
});

describe("processMaintenanceJob", () => {
  beforeEach(reset);

  it("marks the job failed with the batch error and lets it run again afterwards", async () => {
    // An orphaned media object gives the soft-deleted purge a storage delete to attempt.
    await db.insert(mediaObjects).values({
      contentType: "image/jpeg",
      extension: "jpg",
      id: "00000000-0000-4000-9000-000000000001",
      mediaType: "image",
      objectKey: "objects/1",
      sha256: "sha-1".padEnd(64, "0"),
      size: 1,
    });
    await db.insert(libraryEntries).values({
      deletedAt: new Date(),
      filename: "gone.jpg",
      logicalPath: "a/gone.jpg",
      mediaObjectId: "00000000-0000-4000-9000-000000000001",
      mtimeMs: 1,
      parentPath: "a",
    });
    const jobId = await insertJob("soft_deleted_purge", {
      phase: "orphaned_media",
      processedCount: 0,
    });
    vi.mocked(deleteMaintenanceObjects).mockRejectedValueOnce(new Error("bucket unreachable"));

    processMaintenanceJob(jobId);
    await waitFor(async () => (await readJob(jobId)).status === "failed");
    expect((await readJob(jobId)).error).toBe("bucket unreachable");
    expect(deleteMaintenanceObjects).toHaveBeenCalledTimes(1);

    // The failed job is no longer held as running: re-arming the row and
    // kicking the worker runs another batch (which now succeeds).
    await db
      .update(maintenanceJobs)
      .set({ error: null, status: "running" })
      .where(eq(maintenanceJobs.id, jobId));
    processMaintenanceJob(jobId);
    await waitFor(async () => (await readJob(jobId)).status === "completed");
    expect(deleteMaintenanceObjects).toHaveBeenCalledTimes(2);
    expect((await readJob(jobId)).progress).toMatchObject({
      phase: "completed",
      processedCount: 1,
    });
    expect(await db.select().from(mediaObjects)).toEqual([]);
  });
});
