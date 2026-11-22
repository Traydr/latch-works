import type { MediaType } from "@latch-works/media-domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  not,
  sql,
} from "drizzle-orm";
import { type Database, db } from "../db";
import { folders, libraryEntries, librarySizeEvents, mediaObjects, syncRuns } from "../db/schema";
import {
  averageDailyGrowth,
  type CumulativePoint,
  type DailyBucket,
  daysBetween,
  fillDailyBuckets,
  formatDayLabel,
  projectForward,
  toCumulativeSeries,
  toDayKey,
} from "./archive-stats-helpers";

const GROWTH_WINDOW_DAYS = 30;

const HISTORY_DAYS = 90;

const TOP_LIMIT = 8;

export interface ArchiveStats {
  byMediaType: Array<{
    bytes: number;
    count: number;
    mediaType: MediaType;
  }>;
  entriesOverTime: CumulativePoint[];
  funFacts: {
    dedupeSavedBytes: number;
    imageCount: number;
    largestObjectBytes: number;
    largestObjectExtension: string | null;
  };
  growth: {
    bytesLast30Days: number;
    bytesPerDay: number;
    entriesLast30Days: number;
    entriesPerDay: number;
    projectedBytesIn90Days: number;
  };
  /** Stored originals no live entry uses, such as the copy a re-encode replaced. */
  reclaimable: {
    bytes: number;
    objectCount: number;
  };
  recentGrowth: Array<{
    /** Net change in the size of live entries that day; a re-encode or a delete is negative. */
    netBytes: number;
    day: string;
    entriesAdded: number;
    label: string;
  }>;
  sizeOverTime: CumulativePoint[];
  syncActivity: Array<{
    completed: number;
    day: string;
    failed: number;
    label: string;
    started: number;
  }>;
  topExtensions: Array<{
    bytes: number;
    count: number;
    extension: string;
  }>;
  topFolders: Array<{
    entryCount: number;
    name: string;
    path: string;
  }>;
  totals: {
    activeEntries: number;
    activeFolders: number;
    archiveAgeDays: number | null;
    averageObjectBytes: number;
    mediaObjectBytes: number;
    mediaObjectCount: number;
    newestObjectAt: string | null;
    oldestObjectAt: string | null;
    softDeletedEntries: number;
  };
}

/**
 * A media object a live library entry references. Every stat counts only these:
 * a content change or a delete leaves the old original stored until a purge in
 * Manage removes it, and counting it would show a re-encode as growth.
 */
function isLiveObject() {
  return exists(
    db
      .select({ id: libraryEntries.id })
      .from(libraryEntries)
      .where(
        and(eq(libraryEntries.mediaObjectId, mediaObjects.id), isNull(libraryEntries.deletedAt)),
      ),
  );
}

function utcDaysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);

  return date;
}

export async function readArchiveStats(database: Database = db): Promise<ArchiveStats> {
  const historyStart = utcDaysAgo(HISTORY_DAYS - 1);
  const growthStart = utcDaysAgo(GROWTH_WINDOW_DAYS - 1);
  const today = toDayKey(new Date());
  const historyStartKey = toDayKey(historyStart);

  const [
    activeEntriesRow,
    softDeletedEntriesRow,
    activeFoldersRow,
    mediaObjectStats,
    ageRow,
    byMediaTypeRows,
    topExtensionRows,
    topFolderRows,
    imageStatsRow,
    largestObjectRow,
    entryBytesRow,
    reclaimableRow,
    sizeBeforeHistoryRow,
    sizeDailyRows,
    entryDailyRows,
    syncDailyRows,
  ] = await Promise.all([
    database
      .select({ value: count() })
      .from(libraryEntries)
      .where(isNull(libraryEntries.deletedAt)),
    database
      .select({ value: count() })
      .from(libraryEntries)
      .where(isNotNull(libraryEntries.deletedAt)),
    database.select({ value: count() }).from(folders).where(isNull(folders.deletedAt)),
    database
      .select({
        bytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number),
        count: count(),
      })
      .from(mediaObjects)
      .where(isLiveObject()),
    database
      .select({
        newest: sql<Date | null>`max(${mediaObjects.createdAt})`,
        oldest: sql<Date | null>`min(${mediaObjects.createdAt})`,
      })
      .from(mediaObjects)
      .where(isLiveObject()),
    database
      .select({
        bytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number),
        count: count(),
        mediaType: mediaObjects.mediaType,
      })
      .from(mediaObjects)
      .where(isLiveObject())
      .groupBy(mediaObjects.mediaType)
      .orderBy(desc(sql`coalesce(sum(${mediaObjects.size}), 0)`)),
    database
      .select({
        bytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number),
        count: count(),
        extension: mediaObjects.extension,
      })
      .from(mediaObjects)
      .where(isLiveObject())
      .groupBy(mediaObjects.extension)
      .orderBy(desc(sql`coalesce(sum(${mediaObjects.size}), 0)`))
      .limit(TOP_LIMIT),
    database
      .select({
        entryCount: sql`count(*)::int`.mapWith(Number),
        name: folders.name,
        path: folders.path,
      })
      .from(libraryEntries)
      .innerJoin(
        folders,
        and(eq(folders.path, libraryEntries.parentPath), isNull(folders.deletedAt)),
      )
      .where(and(isNull(libraryEntries.deletedAt), ne(libraryEntries.parentPath, "")))
      .groupBy(folders.path, folders.name)
      .orderBy(desc(sql`count(*)`))
      .limit(TOP_LIMIT),
    database
      .select({
        imageCount: count(),
      })
      .from(mediaObjects)
      .where(and(sql`${mediaObjects.mediaType} in ('image', 'gif')`, isLiveObject())),
    database
      .select({
        extension: mediaObjects.extension,
        size: mediaObjects.size,
      })
      .from(mediaObjects)
      .where(isLiveObject())
      .orderBy(desc(mediaObjects.size))
      .limit(1),
    database
      .select({
        entryBytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number),
      })
      .from(libraryEntries)
      .innerJoin(mediaObjects, eq(libraryEntries.mediaObjectId, mediaObjects.id))
      .where(isNull(libraryEntries.deletedAt)),
    database
      .select({
        bytes: sql`coalesce(sum(${mediaObjects.size}), 0)`.mapWith(Number),
        count: count(),
      })
      .from(mediaObjects)
      .where(not(isLiveObject())),
    database
      .select({
        bytes: sql`coalesce(sum(${librarySizeEvents.bytesDelta}), 0)`.mapWith(Number),
      })
      .from(librarySizeEvents)
      .where(lt(librarySizeEvents.occurredAt, historyStart)),
    database
      .select({
        bytes: sql`coalesce(sum(${librarySizeEvents.bytesDelta}), 0)`.mapWith(Number),
        day: sql<string>`to_char(date_trunc('day', ${librarySizeEvents.occurredAt} at time zone 'utc'), 'YYYY-MM-DD')`,
      })
      .from(librarySizeEvents)
      .where(gte(librarySizeEvents.occurredAt, historyStart))
      .groupBy(sql`date_trunc('day', ${librarySizeEvents.occurredAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${librarySizeEvents.occurredAt} at time zone 'utc')`)),
    database
      .select({
        count: count(),
        day: sql<string>`to_char(date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc'), 'YYYY-MM-DD')`,
      })
      .from(libraryEntries)
      .where(and(isNull(libraryEntries.deletedAt), gte(libraryEntries.firstSeenAt, historyStart)))
      .groupBy(sql`date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc')`)),
    database
      .select({
        completed:
          sql`coalesce(sum(case when ${syncRuns.status} = 'completed' then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        day: sql<string>`to_char(date_trunc('day', ${syncRuns.startedAt} at time zone 'utc'), 'YYYY-MM-DD')`,
        failed:
          sql`coalesce(sum(case when ${syncRuns.status} = 'failed' then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        started: count(),
      })
      .from(syncRuns)
      .where(gte(syncRuns.startedAt, historyStart))
      .groupBy(sql`date_trunc('day', ${syncRuns.startedAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${syncRuns.startedAt} at time zone 'utc')`)),
  ]);

  const mediaObjectBytes = mediaObjectStats[0]?.bytes ?? 0;
  const mediaObjectCount = mediaObjectStats[0]?.count ?? 0;
  const oldestObjectAt = ageRow[0]?.oldest ? new Date(ageRow[0].oldest) : null;
  const newestObjectAt = ageRow[0]?.newest ? new Date(ageRow[0].newest) : null;

  // The ledger's running sum is the size of live entries, so the window starts
  // from everything that happened before it and each day adds its net change.
  const sizeDaily: DailyBucket[] = fillDailyBuckets(
    sizeDailyRows.map((row) => ({ day: row.day, value: row.bytes })),
    { endDay: today, startDay: historyStartKey },
  );

  const firstSizeDay = sizeDaily[0];

  if (firstSizeDay) {
    sizeDaily[0] = {
      day: firstSizeDay.day,
      value: firstSizeDay.value + (sizeBeforeHistoryRow[0]?.bytes ?? 0),
    };
  }

  const activeEntries = activeEntriesRow[0]?.value ?? 0;
  const entriesInWindow = entryDailyRows.reduce((sum, row) => sum + (row.count ?? 0), 0);
  const baselineEntries = Math.max(0, activeEntries - entriesInWindow);

  const entryDaily: DailyBucket[] = fillDailyBuckets(
    entryDailyRows.map((row) => ({
      day: row.day,
      value: row.count ?? 0,
    })),
    { endDay: today, startDay: historyStartKey },
  );

  const firstEntryDay = entryDaily[0];

  if (firstEntryDay) {
    entryDaily[0] = {
      day: firstEntryDay.day,
      value: firstEntryDay.value + baselineEntries,
    };
  } else if (activeEntries > 0) {
    entryDaily.push({ day: today, value: activeEntries });
  }

  const sizeOverTime = toCumulativeSeries(sizeDaily);
  const entriesOverTime = toCumulativeSeries(entryDaily);

  const growthDailyBytes = fillDailyBuckets(
    sizeDailyRows.map((row) => ({
      day: row.day,
      value: row.bytes,
    })),
    { endDay: today, startDay: toDayKey(growthStart) },
  );

  const growthDailyEntries = fillDailyBuckets(
    entryDailyRows.map((row) => ({
      day: row.day,
      value: row.count ?? 0,
    })),
    { endDay: today, startDay: toDayKey(growthStart) },
  );

  const bytesLast30Days = growthDailyBytes.reduce((sum, bucket) => sum + bucket.value, 0);
  const entriesLast30Days = growthDailyEntries.reduce((sum, bucket) => sum + bucket.value, 0);
  const archiveStartedOn = oldestObjectAt ? toDayKey(oldestObjectAt) : null;

  const bytesPerDay = averageDailyGrowth(growthDailyBytes, GROWTH_WINDOW_DAYS, today, {
    archiveStartedOn,
  });

  const entriesPerDay = averageDailyGrowth(growthDailyEntries, GROWTH_WINDOW_DAYS, today, {
    archiveStartedOn,
  });

  const syncByDay = new Map(
    syncDailyRows.map((row) => [
      row.day,
      {
        completed: row.completed,
        failed: row.failed,
        started: row.started ?? 0,
      },
    ]),
  );

  const syncActivity = fillDailyBuckets(
    [...syncByDay.entries()].map(([day, values]) => ({ day, value: values.started })),
    { endDay: today, startDay: historyStartKey },
  ).map((bucket) => {
    const values = syncByDay.get(bucket.day) ?? { completed: 0, failed: 0, started: 0 };

    return {
      completed: values.completed,
      day: bucket.day,
      failed: values.failed,
      label: formatDayLabel(bucket.day),
      started: values.started,
    };
  });

  const recentGrowth = growthDailyBytes.map((bucket, index) => ({
    netBytes: bucket.value,
    day: bucket.day,
    entriesAdded: growthDailyEntries[index]?.value ?? 0,
    label: formatDayLabel(bucket.day),
  }));

  const entryBytes = entryBytesRow[0]?.entryBytes ?? 0;
  // When multiple library paths share content-addressed objects, entry bytes exceed
  // unique object bytes. Treat that gap as "saved" by dedupe.
  const dedupeSavedBytes = Math.max(0, entryBytes - mediaObjectBytes);

  return {
    byMediaType: byMediaTypeRows.map((row) => ({
      bytes: row.bytes,
      count: row.count,
      mediaType: row.mediaType,
    })),
    entriesOverTime,
    funFacts: {
      dedupeSavedBytes,
      imageCount: imageStatsRow[0]?.imageCount ?? 0,
      largestObjectBytes: largestObjectRow[0]?.size ?? 0,
      largestObjectExtension: largestObjectRow[0]?.extension ?? null,
    },
    growth: {
      bytesLast30Days,
      bytesPerDay,
      entriesLast30Days,
      entriesPerDay,
      projectedBytesIn90Days: projectForward(mediaObjectBytes, bytesPerDay, 90),
    },
    reclaimable: {
      bytes: reclaimableRow[0]?.bytes ?? 0,
      objectCount: reclaimableRow[0]?.count ?? 0,
    },
    recentGrowth,
    sizeOverTime,
    syncActivity,
    topExtensions: topExtensionRows.map((row) => ({
      bytes: row.bytes,
      count: row.count,
      extension: row.extension.startsWith(".") ? row.extension : `.${row.extension}`,
    })),
    topFolders: topFolderRows.map((row) => ({
      entryCount: row.entryCount,
      name: row.name,
      path: row.path,
    })),
    totals: {
      activeEntries,
      activeFolders: activeFoldersRow[0]?.value ?? 0,
      archiveAgeDays: daysBetween(oldestObjectAt, newestObjectAt ?? new Date()),
      averageObjectBytes: mediaObjectCount > 0 ? mediaObjectBytes / mediaObjectCount : 0,
      mediaObjectBytes,
      mediaObjectCount,
      newestObjectAt: newestObjectAt?.toISOString() ?? null,
      oldestObjectAt: oldestObjectAt?.toISOString() ?? null,
      softDeletedEntries: softDeletedEntriesRow[0]?.value ?? 0,
    },
  };
}
