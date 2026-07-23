import { describe, expect, it } from "vitest";
import { applySecurityHeadersToResponse, isMediaDeliveryPath } from "./security-headers";

describe("isMediaDeliveryPath", () => {
  it("matches CDN and signed media API routes", () => {
    expect(isMediaDeliveryPath("/cdn/v1/token~sig")).toBe(false);
    expect(isMediaDeliveryPath("/api/media/abc/original")).toBe(true);
    expect(isMediaDeliveryPath("/api/media/abc/thumbnail")).toBe(true);
    expect(isMediaDeliveryPath("/api/media/abc/preview")).toBe(true);
  });

  it("does not match app or sync routes", () => {
    expect(isMediaDeliveryPath("/")).toBe(false);
    expect(isMediaDeliveryPath("/login")).toBe(false);
    expect(isMediaDeliveryPath("/manage")).toBe(false);
    expect(isMediaDeliveryPath("/api/health")).toBe(false);
    expect(isMediaDeliveryPath("/api/sync/runs")).toBe(false);
    expect(isMediaDeliveryPath("/api/media/abc")).toBe(false);
  });
});

describe("applySecurityHeadersToResponse", () => {
  it("applies app headers for representative HTML routes", () => {
    const response = new Response("<html></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 200,
    });

    applySecurityHeadersToResponse(response, "/login");

    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("applies delivery headers for media routes", () => {
    const response = new Response(null, {
      headers: { Location: "/cdn/v1/token" },
      status: 302,
    });

    applySecurityHeadersToResponse(response, "/api/media/abc/original");

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });
});
