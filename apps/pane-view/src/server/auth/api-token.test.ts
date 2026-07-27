import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncToken = "test-sync-token-value";
let configuredSyncToken: string | undefined = syncToken;

vi.mock("../../env/server", () => ({
  env: {
    get PANE_VIEW_SYNC_TOKEN() {
      return configuredSyncToken;
    },
  },
}));

import {
  assertSyncApiTokenFromBody,
  getSyncApiTokenDigestCacheForTests,
  hashApiToken,
  readBearerToken,
  requireSyncApiToken,
  resetSyncApiTokenDigestCacheForTests,
  verifySyncApiToken,
} from "./api-token";

function syncRequest(authorization?: string): Request {
  return new Request(
    "http://localhost/api/sync/upload-url",
    authorization === undefined ? undefined : { headers: { Authorization: authorization } },
  );
}

describe("readBearerToken", () => {
  it.each([
    ["header is absent", undefined, null],
    ["scheme is not bearer", "Basic abc123", null],
    ["token is blank after trimming", "Bearer    ", null],
    ["token has surrounding whitespace", "Bearer  sync-token  ", "sync-token"],
  ])("reads %s", (_case, authorization, expected) => {
    expect(readBearerToken(syncRequest(authorization))).toBe(expected);
  });
});

describe("hashApiToken", () => {
  it("returns the SHA-256 hex digest of the token", () => {
    const expected = crypto.createHash("sha256").update("sync-token").digest("hex");

    expect(hashApiToken("sync-token")).toBe(expected);
  });
});

describe("verifySyncApiToken", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
    resetSyncApiTokenDigestCacheForTests();
  });

  it("accepts only an exact match against a configured token", () => {
    expect(verifySyncApiToken({ token: syncToken })).toBe(true);
    expect(verifySyncApiToken({ token: "wrong-token" })).toBe(false);
    expect(verifySyncApiToken({ token: null })).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    configuredSyncToken = undefined;

    expect(verifySyncApiToken({ token: syncToken })).toBe(false);
  });

  it("caches the configured token digest across requests", () => {
    expect(getSyncApiTokenDigestCacheForTests().configuredTokenDigest).toBeNull();

    verifySyncApiToken({ token: "wrong-token" });
    const digestAfterFirst = getSyncApiTokenDigestCacheForTests().configuredTokenDigest;

    expect(digestAfterFirst).not.toBeNull();

    verifySyncApiToken({ token: syncToken });

    expect(getSyncApiTokenDigestCacheForTests().configuredTokenDigest).toBe(digestAfterFirst);
  });
});

describe("requireSyncApiToken", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
    resetSyncApiTokenDigestCacheForTests();
  });

  it("passes a valid bearer token through and 401s an invalid one", () => {
    expect(requireSyncApiToken(syncRequest(`Bearer ${syncToken}`))).toBeNull();
    expect(requireSyncApiToken(syncRequest("Bearer wrong-token"))?.status).toBe(401);
  });
});

describe("assertSyncApiTokenFromBody", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
    resetSyncApiTokenDigestCacheForTests();
  });

  it("accepts a valid body token and throws on an invalid one", () => {
    expect(() => assertSyncApiTokenFromBody(syncToken)).not.toThrow();
    expect(() => assertSyncApiTokenFromBody("wrong-token")).toThrow("Invalid sync token.");
  });
});
