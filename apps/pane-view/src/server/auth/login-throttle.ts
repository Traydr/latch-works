import { inArray, lt, sql } from "drizzle-orm";
import { type Database, db } from "../db";
import { loginThrottleAttempts } from "../db/schema";

type ThrottleExecutor = Pick<Database, "insert">;

/**
 * Builds the atomic attempt upsert, returning the key's count after it.
 *
 * Every `case` reads the *existing* row: in `on conflict do update`, PostgreSQL
 * evaluates all `set` right-hand sides against the pre-update tuple, so
 * assigning `expires_at` last cannot disturb the `count` and `window_start`
 * branches. An expired row therefore restarts the window at 1 rather than
 * continuing to accumulate, which is what makes the fixed window fixed.
 */
function buildLoginThrottleUpsert(
  executor: ThrottleExecutor,
  key: string,
  currentTime: Date,
  nextExpiry: Date,
) {
  return executor
    .insert(loginThrottleAttempts)
    .values({
      count: 1,
      expiresAt: nextExpiry,
      key,
      windowStart: currentTime,
    })
    .onConflictDoUpdate({
      target: loginThrottleAttempts.key,
      set: {
        count: sql`case
          when ${loginThrottleAttempts.expiresAt} < ${currentTime} then 1
          else ${loginThrottleAttempts.count} + 1
        end`,
        expiresAt: sql`case
          when ${loginThrottleAttempts.expiresAt} < ${currentTime} then ${nextExpiry}
          else ${loginThrottleAttempts.expiresAt}
        end`,
        windowStart: sql`case
          when ${loginThrottleAttempts.expiresAt} < ${currentTime} then ${currentTime}
          else ${loginThrottleAttempts.windowStart}
        end`,
      },
    })
    .returning({ count: loginThrottleAttempts.count });
}

const MAX_FAILED_ATTEMPTS = 5;

const WINDOW_MS = 5 * 60 * 1000;

function throttleKeys(ip: string, username: string): string[] {
  const user = username.trim().toLowerCase();

  return [`${ip}:${user}`, `user:${user}`];
}

/**
 * Atomically counts one attempt against every key and returns each key's
 * count within its current window, including this attempt. Concurrent calls
 * each observe a distinct count, so a burst cannot all read the same
 * pre-attempt total.
 */
async function reserveAttempts(
  database: Database,
  keys: string[],
  currentTime: Date,
  nextExpiry: Date,
): Promise<number[]> {
  // Prune before the transaction, not inside it. A global delete holds locks
  // in scan order, so folding it into the upsert transaction would let two
  // concurrent login attempts acquire row locks in opposite orders.
  await database
    .delete(loginThrottleAttempts)
    .where(lt(loginThrottleAttempts.expiresAt, currentTime));

  return database.transaction(async (tx) => {
    const counts: number[] = [];

    for (const key of keys) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stable lock order prevents concurrent login transactions from deadlocking.
      const [row] = await buildLoginThrottleUpsert(tx, key, currentTime, nextExpiry);

      if (!row) {
        throw new Error(`login throttle upsert returned no row for ${key}`);
      }

      counts.push(row.count);
    }

    return counts;
  });
}

export function createDatabaseLoginThrottle(database: Database, now: () => number = Date.now) {
  return {
    async clearLoginThrottle(ip: string, username: string): Promise<void> {
      await database
        .delete(loginThrottleAttempts)
        .where(inArray(loginThrottleAttempts.key, throttleKeys(ip, username)));
    },

    /**
     * Counts an attempt before the credentials are checked and reports whether
     * it may proceed. Every attempt counts as a failure until a successful
     * sign-in clears the buckets, so parallel guesses cannot slip past the
     * limit between a check and a later write.
     */
    async reserveLoginAttempt(ip: string, username: string): Promise<boolean> {
      const currentTime = now();

      const counts = await reserveAttempts(
        database,
        throttleKeys(ip, username),
        new Date(currentTime),
        new Date(currentTime + WINDOW_MS),
      );

      return counts.every((count) => count <= MAX_FAILED_ATTEMPTS);
    },
  };
}

const sharedLoginThrottle = createDatabaseLoginThrottle(db);

export const { clearLoginThrottle, reserveLoginAttempt } = sharedLoginThrottle;
