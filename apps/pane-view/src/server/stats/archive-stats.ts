import { and, asc, count, desc, eq, exists, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { folders, libraryEntries, mediaObjects, syncRuns } from "../db/schema";
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
    mediaType: string;
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
  recentGrowth: Array<{
    bytesAdded: number;
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

function utcDaysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }
  return 0;
}

function dayFromSql(value: unknown): string {
  if (value instanceof Date) {
    return toDayKey(value);
  }
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  return toDayKey(new Date());
}

export async function readArchiveStats(): Promise<ArchiveStats> {
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
    referencedObjectBytesRow,
    objectDailyRows,
    entryDailyRows,
    syncDailyRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(libraryEntries).where(isNull(libraryEntries.deletedAt)),
    db.select({ value: count() }).from(libraryEntries).where(isNotNull(libraryEntries.deletedAt)),
    db.select({ value: count() }).from(folders).where(isNull(folders.deletedAt)),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        count: count(),
      })
      .from(mediaObjects),
    db
      .select({
        newest: sql<Date | null>`max(${mediaObjects.createdAt})`,
        oldest: sql<Date | null>`min(${mediaObjects.createdAt})`,
      })
      .from(mediaObjects),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        count: count(),
        mediaType: mediaObjects.mediaType,
      })
      .from(mediaObjects)
      .groupBy(mediaObjects.mediaType)
      .orderBy(desc(sql`coalesce(sum(${mediaObjects.size}), 0)`)),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        count: count(),
        extension: mediaObjects.extension,
      })
      .from(mediaObjects)
      .groupBy(mediaObjects.extension)
      .orderBy(desc(sql`coalesce(sum(${mediaObjects.size}), 0)`))
      .limit(TOP_LIMIT),
    db
      .select({
        entryCount: sql<number>`count(*)::int`,
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
    db
      .select({
        imageCount: count(),
      })
      .from(mediaObjects)
      .where(sql`${mediaObjects.mediaType} in ('image', 'gif')`),
    db
      .select({
        extension: mediaObjects.extension,
        size: mediaObjects.size,
      })
      .from(mediaObjects)
      .orderBy(desc(mediaObjects.size))
      .limit(1),
    db
      .select({
        entryBytes: sql<number>`coalesce(sum(${libraryEntries.size}), 0)`,
      })
      .from(libraryEntries)
      .where(isNull(libraryEntries.deletedAt)),
    db
      .select({
        objectBytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
      })
      .from(mediaObjects)
      .where(
        exists(
          db
            .select({ id: libraryEntries.id })
            .from(libraryEntries)
            .where(
              and(
                eq(libraryEntries.mediaObjectId, mediaObjects.id),
                isNull(libraryEntries.deletedAt),
              ),
            ),
        ),
      ),
    db
      .select({
        bytes: sql<number>`coalesce(sum(${mediaObjects.size}), 0)`,
        day: sql<string>`to_char(date_trunc('day', ${mediaObjects.createdAt} at time zone 'utc'), 'YYYY-MM-DD')`,
      })
      .from(mediaObjects)
      .where(gte(mediaObjects.createdAt, historyStart))
      .groupBy(sql`date_trunc('day', ${mediaObjects.createdAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${mediaObjects.createdAt} at time zone 'utc')`)),
    db
      .select({
        count: count(),
        day: sql<string>`to_char(date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc'), 'YYYY-MM-DD')`,
      })
      .from(libraryEntries)
      .where(and(isNull(libraryEntries.deletedAt), gte(libraryEntries.firstSeenAt, historyStart)))
      .groupBy(sql`date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${libraryEntries.firstSeenAt} at time zone 'utc')`)),
    db
      .select({
        completed: sql<number>`coalesce(sum(case when ${syncRuns.status} = 'completed' then 1 else 0 end), 0)`,
        day: sql<string>`to_char(date_trunc('day', ${syncRuns.startedAt} at time zone 'utc'), 'YYYY-MM-DD')`,
        failed: sql<number>`coalesce(sum(case when ${syncRuns.status} = 'failed' then 1 else 0 end), 0)`,
        started: count(),
      })
      .from(syncRuns)
      .where(gte(syncRuns.startedAt, historyStart))
      .groupBy(sql`date_trunc('day', ${syncRuns.startedAt} at time zone 'utc')`)
      .orderBy(asc(sql`date_trunc('day', ${syncRuns.startedAt} at time zone 'utc')`)),
  ]);

  const mediaObjectBytes = asNumber(mediaObjectStats[0]?.bytes);
  const mediaObjectCount = mediaObjectStats[0]?.count ?? 0;
  const oldestObjectAt = ageRow[0]?.oldest ? new Date(ageRow[0].oldest) : null;
  const newestObjectAt = ageRow[0]?.newest ? new Date(ageRow[0].newest) : null;

  // Baseline size before the visible window so the cumulative chart meets today's total.
  const bytesInWindow = objectDailyRows.reduce((sum, row) => sum + asNumber(row.bytes), 0);
  const baselineBytes = Math.max(0, mediaObjectBytes - bytesInWindow);

  const objectDaily: DailyBucket[] = fillDailyBuckets(
    objectDailyRows.map((row) => ({
      day: dayFromSql(row.day),
      value: asNumber(row.bytes),
    })),
    { endDay: today, startDay: historyStartKey },
  );
  const firstObjectDay = objectDaily[0];
  if (firstObjectDay) {
    objectDaily[0] = {
      day: firstObjectDay.day,
      value: firstObjectDay.value + baselineBytes,
    };
  } else if (mediaObjectBytes > 0) {
    objectDaily.push({ day: today, value: mediaObjectBytes });
  }

  const activeEntries = activeEntriesRow[0]?.value ?? 0;
  const entriesInWindow = entryDailyRows.reduce((sum, row) => sum + (row.count ?? 0), 0);
  const baselineEntries = Math.max(0, activeEntries - entriesInWindow);
  const entryDaily: DailyBucket[] = fillDailyBuckets(
    entryDailyRows.map((row) => ({
      day: dayFromSql(row.day),
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

  const sizeOverTime = toCumulativeSeries(objectDaily);
  const entriesOverTime = toCumulativeSeries(entryDaily);

  const growthDailyBytes = fillDailyBuckets(
    objectDailyRows.map((row) => ({
      day: dayFromSql(row.day),
      value: asNumber(row.bytes),
    })),
    { endDay: today, startDay: toDayKey(growthStart) },
  );
  const growthDailyEntries = fillDailyBuckets(
    entryDailyRows.map((row) => ({
      day: dayFromSql(row.day),
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
      dayFromSql(row.day),
      {
        completed: asNumber(row.completed),
        failed: asNumber(row.failed),
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
    bytesAdded: bucket.value,
    day: bucket.day,
    entriesAdded: growthDailyEntries[index]?.value ?? 0,
    label: formatDayLabel(bucket.day),
  }));

  const entryBytes = asNumber(entryBytesRow[0]?.entryBytes);
  const referencedObjectBytes = asNumber(referencedObjectBytesRow[0]?.objectBytes);
  // When multiple library paths share content-addressed objects, entry bytes exceed
  // unique object bytes. Treat that gap as "saved" by dedupe.
  const dedupeSavedBytes = Math.max(0, entryBytes - referencedObjectBytes);

  return {
    byMediaType: byMediaTypeRows.map((row) => ({
      bytes: asNumber(row.bytes),
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
    recentGrowth,
    sizeOverTime,
    syncActivity,
    topExtensions: topExtensionRows.map((row) => ({
      bytes: asNumber(row.bytes),
      count: row.count,
      extension: row.extension.startsWith(".") ? row.extension : `.${row.extension}`,
    })),
    topFolders: topFolderRows.map((row) => ({
      entryCount: asNumber(row.entryCount),
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
