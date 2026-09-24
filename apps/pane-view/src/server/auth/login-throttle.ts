import { inArray, lt, sql } from "drizzle-orm";
import { type Database, db } from "../db";
import { loginThrottleAttempts } from "../db/schema";
import { createLoginThrottle, type LoginThrottleStore } from "./login-throttle-core";

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

function createDatabaseLoginThrottleStore(database: Database): LoginThrottleStore {
  return {
    async clear(keys) {
      await database.delete(loginThrottleAttempts).where(inArray(loginThrottleAttempts.key, keys));
    },

    async reserve(keys, now, expiresAt) {
      const currentTime = new Date(now);
      const nextExpiry = new Date(expiresAt);

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
    },
  };
}

export function createDatabaseLoginThrottle(database: Database, now?: () => number) {
  return createLoginThrottle({ now, store: createDatabaseLoginThrottleStore(database) });
}

const sharedLoginThrottle = createDatabaseLoginThrottle(db);

export const { clearLoginThrottle, reserveLoginAttempt } = sharedLoginThrottle;
