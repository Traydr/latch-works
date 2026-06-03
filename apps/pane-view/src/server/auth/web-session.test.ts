import { describe, expect, it } from "vitest";
import { auth, ensureConfiguredOwnerCredentialAccount, readConfiguredOwner } from "./better-auth";
import { isRequestSessionValid, readRequestSessionUserId } from "./web-session-core";

describe("web session guard", () => {
  it("rejects requests without a Better Auth session cookie", async () => {
    const request = new Request("https://pane-view.invalid/");

    await expect(isRequestSessionValid({ request })).resolves.toBe(false);
    await expect(readRequestSessionUserId({ request })).resolves.toBeNull();
  });

  it("accepts Better Auth session cookies", async () => {
    const owner = readConfiguredOwner();

    await ensureConfiguredOwnerCredentialAccount(owner);

    const response = await auth.handler(
      new Request("https://pane-view.invalid/api/auth/sign-in/email", {
        body: JSON.stringify({
          email: owner.email,
          password: owner.password,
          rememberMe: true,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    const cookie = readSetCookie(response.headers);
    const request = new Request("https://pane-view.invalid/", {
      headers: { Cookie: cookie },
    });

    await expect(isRequestSessionValid({ request })).resolves.toBe(true);
    await expect(readRequestSessionUserId({ request })).resolves.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does not allow Better Auth email signups", async () => {
    const response = await auth.handler(
      new Request("https://pane-view.invalid/api/auth/sign-up/email", {
        body: JSON.stringify({
          email: "blocked-signup@pane-view.test",
          name: "blocked",
          password: "secret",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.ok).toBe(false);
  });
});

function readSetCookie(headers: Headers): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookie = getSetCookie?.call(headers)[0] ?? headers.get("Set-Cookie");

  if (!cookie) {
    throw new Error("Expected Better Auth to set a session cookie.");
  }

  return cookie;
}
