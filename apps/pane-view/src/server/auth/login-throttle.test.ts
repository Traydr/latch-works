import { beforeEach, describe, expect, it } from "vitest";
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
});
