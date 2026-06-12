import { beforeEach, describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";
import {
  isLoginThrottled,
  recordFailedLogin,
  resetLoginThrottleForTests,
} from "./login-throttle";

function requestWithForwardedFor(value: string): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    headers: { "x-forwarded-for": value },
  });
}

describe("login throttle spoofing resistance", () => {
  beforeEach(() => {
    resetLoginThrottleForTests();
  });

  it("does not bypass throttling by rotating x-forwarded-for when proxy trust is disabled", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const request = requestWithForwardedFor(`203.0.113.${attempt}`);
      const clientIp = resolveClientIp(request, false);
      recordFailedLogin(clientIp, "owner");
    }

    const rotatedRequest = requestWithForwardedFor("198.51.100.99");
    const rotatedIp = resolveClientIp(rotatedRequest, false);

    expect(rotatedIp).toBe("unknown");
    expect(isLoginThrottled(rotatedIp, "owner")).toBe(true);
  });
});
