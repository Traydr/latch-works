import { describe, expect, it } from "vitest";
import { env } from "../../env/server";
import { hashApiToken, readBearerToken, verifySyncApiToken } from "./api-token";

describe("sync api token helpers", () => {
  it("reads bearer tokens", () => {
    const request = new Request("https://pane-view.invalid", {
      headers: { Authorization: "Bearer token-123" },
    });

    expect(readBearerToken(request)).toBe("token-123");
  });

  it("verifies the configured sync token", () => {
    expect(verifySyncApiToken({ token: env.PANE_VIEW_SYNC_TOKEN })).toBe(true);
    expect(verifySyncApiToken({ token: "wrong" })).toBe(false);
    expect(hashApiToken(env.PANE_VIEW_SYNC_TOKEN)).toHaveLength(64);
  });
});
