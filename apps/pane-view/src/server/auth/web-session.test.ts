import { describe, expect, it } from "vitest";
import { sessionCookieName } from "./session";
import { isRequestSessionValid } from "./web-session-core";

describe("web session guard", () => {
  it("rejects requests without the Pane View session cookie", async () => {
    const request = new Request("https://pane-view.invalid/");

    await expect(isRequestSessionValid({ env: {}, request })).resolves.toBe(false);
  });

  it("accepts prototype sessions when database storage is not configured", async () => {
    const request = new Request("https://pane-view.invalid/", {
      headers: { Cookie: `${sessionCookieName}=prototype-token` },
    });

    await expect(isRequestSessionValid({ env: {}, request })).resolves.toBe(true);
  });
});
