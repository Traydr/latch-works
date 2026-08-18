import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { syncRuns } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { forceCancelAllRunningSyncRuns, forceCancelSyncRun } from "./sync-run-control";

const testDatabase = testDatabaseForSuite();

async function insertRun(status: "running" | "completed", sourceRoot: string): Promise<string> {
  const { db } = testDatabase();
  const [run] = await db
    .insert(syncRuns)
    .values({ sourceRoot, status })
    .returning({ id: syncRuns.id });
  if (!run) throw new Error("failed to insert sync run");
  return run.id;
}

describe("sync run control", () => {
  it("cancels a single running sync run", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("running", "/archive");

    expect(await forceCancelSyncRun({ syncRunId }, db)).toEqual({ cancelled: true });

    const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, syncRunId));
    expect(run?.status).toBe("cancelled");
    expect(run?.error).toBe("Manually cancelled from Pane View management.");
    expect(run?.completedAt).toBeInstanceOf(Date);

    await db.delete(syncRuns);
  });

  it("returns false when the sync run is not running", async () => {
    const { db } = testDatabase();
    const syncRunId = await insertRun("completed", "/archive");

    expect(await forceCancelSyncRun({ syncRunId }, db)).toEqual({ cancelled: false });

    await db.delete(syncRuns);
  });

  it("cancels all running sync runs", async () => {
    const { db } = testDatabase();
    await insertRun("running", "/archive-one");
    await insertRun("running", "/archive-two");
    await insertRun("completed", "/archive-three");

    expect(await forceCancelAllRunningSyncRuns(db)).toEqual({ cancelledCount: 2 });
    expect(await forceCancelAllRunningSyncRuns(db)).toEqual({ cancelledCount: 0 });

    await db.delete(syncRuns);
  });
});
