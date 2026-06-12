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

  it("clears the throttle after a successful login", () => {
    recordFailedLogin("127.0.0.1", "owner");
    clearLoginThrottle("127.0.0.1", "owner");

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
});
