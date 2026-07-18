export interface DailyBucket {
  day: string;
  value: number;
}

export interface CumulativePoint {
  day: string;
  label: string;
  value: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date as YYYY-MM-DD in UTC. */
export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Short chart label like "Jan 5". */
export function formatDayLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Fill missing days between first and last bucket with zeros. */
export function fillDailyBuckets(
  buckets: DailyBucket[],
  options?: { endDay?: string; startDay?: string },
): DailyBucket[] {
  if (buckets.length === 0 && !options?.startDay) {
    return [];
  }

  const byDay = new Map(buckets.map((bucket) => [bucket.day, Number(bucket.value) || 0]));
  const sortedKeys = [...byDay.keys()].sort();
  const start = options?.startDay ?? sortedKeys[0];
  const end = options?.endDay ?? sortedKeys[sortedKeys.length - 1];
  if (!start || !end) {
    return [];
  }

  const filled: DailyBucket[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= endDate) {
    const day = toDayKey(cursor);
    filled.push({ day, value: byDay.get(day) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

/** Turn daily deltas into a cumulative series for size-over-time charts. */
export function toCumulativeSeries(buckets: DailyBucket[]): CumulativePoint[] {
  let running = 0;
  return buckets.map((bucket) => {
    running += Number(bucket.value) || 0;
    return {
      day: bucket.day,
      label: formatDayLabel(bucket.day),
      value: running,
    };
  });
}

/** Average daily growth over a window ending at `endDay` (inclusive). */
export function averageDailyGrowth(
  daily: DailyBucket[],
  windowDays: number,
  endDay = toDayKey(new Date()),
): number {
  if (windowDays <= 0) {
    return 0;
  }

  const end = new Date(`${endDay}T00:00:00.000Z`);
  const start = new Date(end.getTime() - (windowDays - 1) * DAY_MS);
  const startKey = toDayKey(start);
  const byDay = new Map(daily.map((bucket) => [bucket.day, Number(bucket.value) || 0]));

  let total = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    total += byDay.get(toDayKey(cursor)) ?? 0;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Ignore leading empty history before the archive existed.
  const firstActivity = daily.find((bucket) => bucket.value > 0)?.day;
  if (!firstActivity || firstActivity > endDay) {
    return 0;
  }

  const effectiveStart = firstActivity > startKey ? firstActivity : startKey;
  const effectiveDays =
    Math.floor((end.getTime() - new Date(`${effectiveStart}T00:00:00.000Z`).getTime()) / DAY_MS) +
    1;

  return total / Math.max(effectiveDays, 1);
}

export function daysBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) {
    return null;
  }
  const diff = Math.max(0, end.getTime() - start.getTime());
  return Math.max(1, Math.ceil(diff / DAY_MS));
}

export function projectForward(current: number, perDay: number, days: number): number {
  return Math.max(0, current + perDay * days);
}
