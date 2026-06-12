import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { libraryEntries, thumbnails } from "../db/schema";
import { regenerateThumbnailDerivative } from "../media/derivative-service";

const defaultRetryLimit = 10;
const defaultThumbnailSize = 320;

export async function retryFailedThumbnails({
  limit = defaultRetryLimit,
}: {
  limit?: number;
} = {}): Promise<{
  attempted: number;
  stillFailed: number;
  succeeded: number;
}> {
  const failedRows = await db
    .select({
      entryId: libraryEntries.id,
      size: thumbnails.size,
    })
    .from(thumbnails)
    .innerJoin(libraryEntries, eq(thumbnails.mediaObjectId, libraryEntries.mediaObjectId))
    .where(and(eq(thumbnails.status, "failed"), isNull(libraryEntries.deletedAt)))
    .limit(limit);

  let succeeded = 0;
  let stillFailed = 0;

  for (const row of failedRows) {
    const result = await regenerateThumbnailDerivative({
      mediaId: row.entryId,
      requestedSize: row.size || defaultThumbnailSize,
    });

    if (result.status === "ready" || result.status === "pending") {
      succeeded += 1;
    } else {
      stillFailed += 1;
    }
  }

  return {
    attempted: failedRows.length,
    stillFailed,
    succeeded,
  };
}
