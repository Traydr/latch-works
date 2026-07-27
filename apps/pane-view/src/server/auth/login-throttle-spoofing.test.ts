import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";
import { createLoginThrottle, type LoginThrottleStore } from "./login-throttle-core";

function requestWithForwardedFor(value: string): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    headers: { "x-forwarded-for": value },
  });
}

describe("login throttle spoofing resistance", () => {
  it("does not bypass throttling by rotating x-forwarded-for when proxy trust is disabled", async () => {
    const attempts = new Map<string, { count: number; expiresAt: number; windowStart: number }>();
    const store: LoginThrottleStore = {
      async clear(keys) {
        for (const key of keys) attempts.delete(key);
      },
      async read(keys, now) {
        return keys.flatMap((key) => {
          const record = attempts.get(key);
          return record && record.expiresAt >= now ? [{ key, ...record }] : [];
        });
      },
      async record(keys, now, expiresAt) {
        for (const key of keys) {
          const record = attempts.get(key);
          attempts.set(key, {
            count: record && record.expiresAt >= now ? record.count + 1 : 1,
            expiresAt: record && record.expiresAt >= now ? record.expiresAt : expiresAt,
            windowStart: record && record.expiresAt >= now ? record.windowStart : now,
          });
        }
      },
    };
    const throttle = createLoginThrottle({ store });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const request = requestWithForwardedFor(`203.0.113.${attempt}`);
      const clientIp = resolveClientIp(request, false);
      await throttle.recordFailedLogin(clientIp, "owner");
    }

    const rotatedRequest = requestWithForwardedFor("198.51.100.99");
    const rotatedIp = resolveClientIp(rotatedRequest, false);

    expect(rotatedIp).toBe("unknown");
    await expect(throttle.isLoginThrottled(rotatedIp, "owner")).resolves.toBe(true);
  });
});
