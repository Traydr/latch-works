import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLoginThrottle,
  isLoginThrottled,
  recordFailedLogin,
  resetLoginThrottleForTests,
} from "./login-throttle";

describe("login throttle", () => {
  beforeEach(() => {
    resetLoginThrottleForTests();
  });

  it("blocks repeated failed attempts for the same ip and username", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedLogin("127.0.0.1", "owner");
    }

    expect(isLoginThrottled("127.0.0.1", "owner")).toBe(true);
  });

  it("blocks the same username after failures from multiple ips", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    expect(isLoginThrottled("198.51.100.1", "owner")).toBe(true);
  });

  it("does not throttle a different username when only one account failed", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    expect(isLoginThrottled("198.51.100.1", "other-user")).toBe(false);
  });

  it("clears both ip and username buckets after a successful login", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    clearLoginThrottle("127.0.0.1", "owner");

    expect(isLoginThrottled("203.0.113.4", "owner")).toBe(false);
    expect(isLoginThrottled("127.0.0.1", "owner")).toBe(false);
  });

  it("prunes expired attempts for other keys when recording a new failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));

    recordFailedLogin("127.0.0.1", "stale-user");

    vi.setSystemTime(new Date("2026-06-12T12:10:00.000Z"));
    recordFailedLogin("127.0.0.1", "fresh-user");

    expect(isLoginThrottled("127.0.0.1", "stale-user")).toBe(false);
    expect(isLoginThrottled("127.0.0.1", "fresh-user")).toBe(false);

    vi.useRealTimers();
  });

  it("resets throttling after the window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00.000Z"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      recordFailedLogin(`203.0.113.${attempt}`, "owner");
    }

    expect(isLoginThrottled("198.51.100.1", "owner")).toBe(true);

    vi.setSystemTime(new Date("2026-06-12T12:06:00.000Z"));

    expect(isLoginThrottled("198.51.100.1", "owner")).toBe(false);

    vi.useRealTimers();
  });
});
