import { describe, expect, it } from "vitest";
import {
  buildExpiredSessionCookie,
  buildSessionCookie,
  hashSessionToken,
  readCookie,
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
    expect(cookie).toContain("__Host-pane_view_session=token");
    expect(cookie).toContain("HttpOnly");
    expect(readCookie(cookie, "__Host-pane_view_session")).toBe("token");

    expect(buildExpiredSessionCookie()).toContain("Expires=Thu, 01 Jan 1970");
  });
});
