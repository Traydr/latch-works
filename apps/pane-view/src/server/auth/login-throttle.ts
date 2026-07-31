import { inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { loginThrottleAttempts } from "../db/schema";
import { createLoginThrottle, type LoginThrottleStore } from "./login-throttle-core";

type ThrottleExecutor = Pick<typeof db, "insert">;

/**
 * Builds the atomic attempt upsert.
 *
 * Every `case` reads the *existing* row: in `on conflict do update`, PostgreSQL
 * evaluates all `set` right-hand sides against the pre-update tuple, so
 * assigning `expires_at` last cannot disturb the `count` and `window_start`
 * branches. An expired row therefore restarts the window at 1 rather than
 * continuing to accumulate, which is what makes the fixed window fixed.
 *
 * Exported so `login-throttle-sql.test.ts` can assert the rendered SQL. That
 * suite is the only coverage this branch logic has — the in-memory stores used
 * by the behavioral suites are separate implementations of the same contract.
 */
export function buildLoginThrottleUpsert(
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
    });
}

const databaseLoginThrottleStore: LoginThrottleStore = {
  async clear(keys) {
    await db.delete(loginThrottleAttempts).where(inArray(loginThrottleAttempts.key, keys));
  },

  async read(keys) {
    // Read-only on purpose: this runs on every login attempt, including
    // successful ones. Expired rows are filtered by the caller, and pruning
    // happens on the write path instead.
    const rows = await db
      .select()
      .from(loginThrottleAttempts)
      .where(inArray(loginThrottleAttempts.key, keys));

    return rows.map((row) => ({
      count: row.count,
      expiresAt: row.expiresAt.getTime(),
      key: row.key,
      windowStart: row.windowStart.getTime(),
    }));
  },

  async record(keys, now, expiresAt) {
    const currentTime = new Date(now);
    const nextExpiry = new Date(expiresAt);

    // Prune before the transaction, not inside it. A global delete holds locks
    // in scan order, so folding it into the upsert transaction would let two
    // concurrent failed logins acquire row locks in opposite orders.
    await db.delete(loginThrottleAttempts).where(lt(loginThrottleAttempts.expiresAt, currentTime));

    await db.transaction(async (tx) => {
      for (const key of keys) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Stable lock order prevents concurrent login transactions from deadlocking.
        await buildLoginThrottleUpsert(tx, key, currentTime, nextExpiry);
      }
    });
  },
};

const sharedLoginThrottle = createLoginThrottle({ store: databaseLoginThrottleStore });

export const { clearLoginThrottle, isLoginThrottled, recordFailedLogin } = sharedLoginThrottle;
