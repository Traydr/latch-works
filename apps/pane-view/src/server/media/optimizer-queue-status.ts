import { and, count, eq, lte, sql } from "drizzle-orm";
import { env, resolveDerivativeProcessingMode } from "../../env/server";
import { db } from "../db";
import { thumbnails } from "../db/schema";
import { derivativeProcessingLeaseMs } from "./derivative-lease";

export interface OptimizerQueueStatus {
  service: "pane-view";
  processingMode: "inline" | "triggered";
  optimizerConfigured: boolean;
  queue: {
    failed: number;
    nextAttemptDue: number;
    oldestPendingAt: string | null;
    pending: number;
    processing: number;
    ready: number;
    staleProcessing: number;
  };
}

export async function readOptimizerQueueStatus(): Promise<OptimizerQueueStatus> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - derivativeProcessingLeaseMs);

  const [statusRows, staleProcessingRows, pendingSummaryRows] = await Promise.all([
    db
      .select({
        status: thumbnails.status,
        value: count(),
      })
      .from(thumbnails)
      .groupBy(thumbnails.status),
    db
      .select({ value: count() })
      .from(thumbnails)
      .where(and(eq(thumbnails.status, "processing"), lte(thumbnails.updatedAt, staleBefore))),
    db
      .select({
        nextAttemptDue: sql<number>`count(*) filter (where ${thumbnails.nextAttemptAt} is null or ${thumbnails.nextAttemptAt} <= ${now})`,
        oldestPendingAt: sql<Date | null>`min(${thumbnails.createdAt})`,
      })
      .from(thumbnails)
      .where(eq(thumbnails.status, "pending")),
  ]);

  const queue = {
    failed: 0,
    nextAttemptDue: pendingSummaryRows[0]?.nextAttemptDue ?? 0,
    oldestPendingAt: pendingSummaryRows[0]?.oldestPendingAt?.toISOString() ?? null,
    pending: 0,
    processing: 0,
    ready: 0,
    staleProcessing: staleProcessingRows[0]?.value ?? 0,
  };

  for (const row of statusRows) {
    if (row.status in queue) {
      queue[row.status as "failed" | "pending" | "processing" | "ready"] = row.value;
    }
  }

  return {
    optimizerConfigured: Boolean(env.MEDIA_OPTIMIZER_TOKEN && env.MEDIA_OPTIMIZER_URL),
    processingMode: resolveDerivativeProcessingMode(),
    queue,
    service: "pane-view",
  };
}
