import { describe, expect, it } from "vitest";
import { createLoginThrottle, type LoginThrottleStore } from "./login-throttle-core";

interface StoredAttempt {
  count: number;
  expiresAt: number;
  key: string;
  windowStart: number;
}

function createMemoryStore(): LoginThrottleStore {
  const attempts = new Map<string, StoredAttempt>();

  return {
    async clear(keys) {
      for (const key of keys) attempts.delete(key);
    },
    async read(keys, now) {
      for (const [key, record] of attempts) {
        if (record.expiresAt < now) attempts.delete(key);
      }
      return keys.flatMap((key) => {
        const record = attempts.get(key);
        return record ? [record] : [];
      });
    },
    async record(keys, now, expiresAt) {
      for (const key of keys) {
        const record = attempts.get(key);
        if (!record || record.expiresAt < now) {
          attempts.set(key, { count: 1, expiresAt, key, windowStart: now });
        } else {
          record.count += 1;
        }
      }
    },
  };
}

describe("login throttle", () => {
  it("blocks repeated failed attempts for the same ip and username", async () => {
    const throttle = createLoginThrottle({ store: createMemoryStore() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await throttle.recordFailedLogin("127.0.0.1", "owner");
    }

    await expect(throttle.isLoginThrottled("127.0.0.1", "owner")).resolves.toBe(true);
  });

  it("blocks the same username after failures from multiple ips", async () => {
    const throttle = createLoginThrottle({ store: createMemoryStore() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await throttle.recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    await expect(throttle.isLoginThrottled("198.51.100.1", "owner")).resolves.toBe(true);
  });

  it("does not throttle a different username when only one account failed", async () => {
    const throttle = createLoginThrottle({ store: createMemoryStore() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await throttle.recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    await expect(throttle.isLoginThrottled("198.51.100.1", "other-user")).resolves.toBe(false);
  });

  it("clears both ip and username buckets after a successful login", async () => {
    const throttle = createLoginThrottle({ store: createMemoryStore() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await throttle.recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    await throttle.clearLoginThrottle("127.0.0.1", "owner");

    await expect(throttle.isLoginThrottled("203.0.113.4", "owner")).resolves.toBe(false);
    await expect(throttle.isLoginThrottled("127.0.0.1", "owner")).resolves.toBe(false);
  });

  it("prunes expired attempts and resets throttling after the window", async () => {
    let now = new Date("2026-06-12T12:00:00.000Z").getTime();
    const throttle = createLoginThrottle({ now: () => now, store: createMemoryStore() });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await throttle.recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }
    await expect(throttle.isLoginThrottled("198.51.100.1", "owner")).resolves.toBe(true);

    now += 6 * 60 * 1_000;

    await expect(throttle.isLoginThrottled("198.51.100.1", "owner")).resolves.toBe(false);
    await throttle.recordFailedLogin("127.0.0.1", "fresh-user");
    await expect(throttle.isLoginThrottled("127.0.0.1", "fresh-user")).resolves.toBe(false);
  });

  it("preserves counters when a new throttle instance uses the shared store", async () => {
    const store = createMemoryStore();
    const firstProcess = createLoginThrottle({ store });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await firstProcess.recordFailedLogin("127.0.0.1", "owner");
    }

    const restartedProcess = createLoginThrottle({ store });

    await expect(restartedProcess.isLoginThrottled("127.0.0.1", "owner")).resolves.toBe(true);
  });
});
