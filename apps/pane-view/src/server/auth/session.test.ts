import { describe, expect, it } from "vitest";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  getSessionCookieName,
  hashSessionToken,
  readCookie,
  sessionCookieName,
  verifySingleUserCredentials,
} from "./session";

describe("session auth helpers", () => {
  it("verifies configured single-user credentials", () => {
    const env = {
      PANE_VIEW_PASSWORD: "secret",
      PANE_VIEW_USERNAME: "traydr",
    };

    expect(verifySingleUserCredentials({ env, password: "secret", username: "traydr" })).toBe(true);
    expect(verifySingleUserCredentials({ env, password: "wrong", username: "traydr" })).toBe(false);
  });

  it("hashes session tokens and serializes cookies", () => {
    expect(hashSessionToken("token")).toHaveLength(64);

    const cookie = buildSessionCookie("token", new Date("2026-06-02T00:00:00.000Z"));
    expect(cookie).toContain(`${sessionCookieName}=token`);
    expect(cookie).toContain("HttpOnly");
    expect(readCookie(cookie, sessionCookieName)).toBe("token");

    expect(buildExpiredSessionCookie()).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("uses a production-only Host-prefixed cookie name", () => {
    expect(getSessionCookieName("development")).toBe("pane_view_session");
    expect(getSessionCookieName("test")).toBe("pane_view_session");
    expect(getSessionCookieName("production")).toBe("__Host-pane_view_session");
  });
});
