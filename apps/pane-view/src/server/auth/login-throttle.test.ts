import { beforeEach, describe, expect, it } from "vitest";
import { loginThrottleAttempts } from "../db/schema";
import { testDatabaseForSuite } from "../library/test-db";
import { resolveClientIp } from "./client-ip";
import { createDatabaseLoginThrottle } from "./login-throttle";

const testDatabase = testDatabaseForSuite();

function createThrottle(now?: () => number) {
  return createDatabaseLoginThrottle(testDatabase().db, now);
}

async function failFiveTimes(
  throttle: ReturnType<typeof createThrottle>,
  ipForAttempt: (attempt: number) => string,
  username = "owner",
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(throttle.reserveLoginAttempt(ipForAttempt(attempt), username)).resolves.toBe(true);
  }
}

describe("login throttle", () => {
  beforeEach(async () => {
    await testDatabase().db.delete(loginThrottleAttempts);
  });

  it("blocks repeated failed attempts for the same ip and username", async () => {
    const throttle = createThrottle();

    await failFiveTimes(throttle, () => "127.0.0.1");

    await expect(throttle.reserveLoginAttempt("127.0.0.1", "owner")).resolves.toBe(false);
  });

  it("blocks the same username after failures from multiple ips", async () => {
    const throttle = createThrottle();

    await failFiveTimes(throttle, (attempt) => `203.0.113.${attempt}`);

    await expect(throttle.reserveLoginAttempt("198.51.100.1", "owner")).resolves.toBe(false);
  });

  it("does not throttle a different username when only one account failed", async () => {
    const throttle = createThrottle();

    await failFiveTimes(throttle, (attempt) => `203.0.113.${attempt}`);

    await expect(throttle.reserveLoginAttempt("198.51.100.1", "other-user")).resolves.toBe(true);
  });

  it("admits only the allowed number of attempts from a parallel burst", async () => {
    const throttle = createThrottle();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => throttle.reserveLoginAttempt("127.0.0.1", "owner")),
    );

    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("clears both ip and username buckets after a successful login", async () => {
    const throttle = createThrottle();

    await failFiveTimes(throttle, (attempt) => `203.0.113.${attempt}`);

    await throttle.clearLoginThrottle("127.0.0.1", "owner");

    await expect(throttle.reserveLoginAttempt("203.0.113.4", "owner")).resolves.toBe(true);
    await expect(throttle.reserveLoginAttempt("127.0.0.1", "owner")).resolves.toBe(true);
  });

  it("prunes expired attempts and resets throttling after the window", async () => {
    let now = new Date("2026-06-12T12:00:00.000Z").getTime();
    const throttle = createThrottle(() => now);

    await failFiveTimes(throttle, (attempt) => `203.0.113.${attempt}`);
    await expect(throttle.reserveLoginAttempt("198.51.100.1", "owner")).resolves.toBe(false);

    now += 6 * 60 * 1_000;

    await expect(throttle.reserveLoginAttempt("198.51.100.1", "owner")).resolves.toBe(true);
    await expect(throttle.reserveLoginAttempt("127.0.0.1", "fresh-user")).resolves.toBe(true);

    const keys = await testDatabase()
      .db.select({ key: loginThrottleAttempts.key })
      .from(loginThrottleAttempts);

    expect(keys.map(({ key }) => key).sort()).toEqual([
      "127.0.0.1:fresh-user",
      "198.51.100.1:owner",
      "user:fresh-user",
      "user:owner",
    ]);
  });

  it("preserves counters when a new throttle instance uses the shared store", async () => {
    await failFiveTimes(createThrottle(), () => "127.0.0.1");

    const restartedProcess = createThrottle();

    await expect(restartedProcess.reserveLoginAttempt("127.0.0.1", "owner")).resolves.toBe(false);
  });

  it("does not bypass throttling by rotating x-forwarded-for when proxy trust is disabled", async () => {
    const throttle = createThrottle();

    const requestWithForwardedFor = (value: string) =>
      new Request("http://localhost:3000/api/auth/login", {
        headers: { "x-forwarded-for": value },
      });

    await failFiveTimes(throttle, (attempt) =>
      resolveClientIp(requestWithForwardedFor(`203.0.113.${attempt}`), false),
    );

    const rotatedIp = resolveClientIp(requestWithForwardedFor("198.51.100.99"), false);
    expect(rotatedIp).toBe("unknown");
    await expect(throttle.reserveLoginAttempt(rotatedIp, "owner")).resolves.toBe(false);
  });
});
