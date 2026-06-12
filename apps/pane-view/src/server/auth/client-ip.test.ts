import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/auth/login", { headers });
}

describe("resolveClientIp", () => {
  it("ignores spoofable forwarding headers when proxy trust is disabled", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
    });

    expect(resolveClientIp(request, false)).toBe("unknown");
  });

  it("uses the first x-forwarded-for address when proxy trust is enabled", () => {
    const request = requestWithHeaders({
      "x-forwarded-for": "203.0.113.1, 198.51.100.2",
    });

    expect(resolveClientIp(request, true)).toBe("203.0.113.1");
  });

  it("falls back to x-real-ip when proxy trust is enabled and x-forwarded-for is absent", () => {
    const request = requestWithHeaders({
      "x-real-ip": "203.0.113.3",
    });

    expect(resolveClientIp(request, true)).toBe("203.0.113.3");
  });
});
