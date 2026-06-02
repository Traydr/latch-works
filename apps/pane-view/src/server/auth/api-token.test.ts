import { describe, expect, it } from "vitest";
import { hashApiToken, readBearerToken, verifySyncApiToken } from "./api-token";

describe("sync api token helpers", () => {
  it("reads bearer tokens", () => {
    const request = new Request("https://pane-view.invalid", {
      headers: { Authorization: "Bearer token-123" },
    });

    expect(readBearerToken(request)).toBe("token-123");
  });

  it("verifies the configured sync token", () => {
    const env = { PANE_VIEW_SYNC_TOKEN: "sync-secret" };

    expect(verifySyncApiToken({ env, token: "sync-secret" })).toBe(true);
    expect(verifySyncApiToken({ env, token: "wrong" })).toBe(false);
    expect(hashApiToken("sync-secret")).toHaveLength(64);
  });
});
