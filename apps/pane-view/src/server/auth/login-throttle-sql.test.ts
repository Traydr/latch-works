import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

import { buildLoginThrottleUpsert } from "./login-throttle";

/**
 * The behavioral throttle suites run against in-memory stores, which are
 * separate implementations of `LoginThrottleStore`. Nothing else executes the
 * SQL that actually enforces brute-force protection in production, so this
 * suite asserts the rendered statement directly. Without it, inverting a
 * comparison or reading `excluded.*` instead of the existing row would leave
 * every other test green.
 */
const executor = drizzle({ client: { query: async () => ({ rows: [] }) } as never });

const currentTime = new Date("2026-07-27T12:00:00.000Z");
const nextExpiry = new Date("2026-07-27T12:05:00.000Z");

function renderedSql(): string {
  return buildLoginThrottleUpsert(executor, "203.0.113.1:owner", currentTime, nextExpiry)
    .toSQL()
    .sql.replace(/\s+/gu, " ");
}

describe("login throttle upsert SQL", () => {
  it("resets an expired window and otherwise increments, reading the existing row", () => {
    expect(renderedSql()).toBe(
      'insert into "login_throttle_attempts" ' +
        '("key", "count", "window_start", "expires_at") values ($1, $2, $3, $4) ' +
        'on conflict ("key") do update set ' +
        '"count" = case when "login_throttle_attempts"."expires_at" < $5 ' +
        'then 1 else "login_throttle_attempts"."count" + 1 end, ' +
        '"window_start" = case when "login_throttle_attempts"."expires_at" < $6 ' +
        'then $7 else "login_throttle_attempts"."window_start" end, ' +
        '"expires_at" = case when "login_throttle_attempts"."expires_at" < $8 ' +
        'then $9 else "login_throttle_attempts"."expires_at" end',
    );
  });

  it("never reads the proposed row, so a fresh attempt cannot extend a live window", () => {
    // `excluded.expires_at` is always the incoming value, so comparing against
    // it would make every attempt look expired and reset the counter to 1 —
    // silently disabling throttling.
    expect(renderedSql()).not.toContain("excluded");
  });

  it("binds the conflict target to the primary key", () => {
    expect(renderedSql()).toContain('on conflict ("key") do update');
  });

  it("sends the comparison timestamps as bound parameters", () => {
    const { params } = buildLoginThrottleUpsert(
      executor,
      "203.0.113.1:owner",
      currentTime,
      nextExpiry,
    ).toSQL();

    // $5/$6/$8 are the three `case when` comparisons; all must be the current
    // time, never the new expiry, or an expired row would fail to reset.
    expect(new Date(params[4] as string).toISOString()).toBe(currentTime.toISOString());
    expect(new Date(params[5] as string).toISOString()).toBe(currentTime.toISOString());
    expect(new Date(params[7] as string).toISOString()).toBe(currentTime.toISOString());
    expect(new Date(params[8] as string).toISOString()).toBe(nextExpiry.toISOString());
  });
});
