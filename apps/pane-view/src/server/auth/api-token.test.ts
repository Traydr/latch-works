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

describe("readBearerToken", () => {
  it("returns null when Authorization is missing", () => {
    const request = new Request("http://localhost/api/sync/upload-url");

    expect(readBearerToken(request)).toBeNull();
  });

  it("returns null when Authorization is not a bearer token", () => {
    const request = new Request("http://localhost/api/sync/upload-url", {
      headers: { Authorization: "Basic abc123" },
    });

    expect(readBearerToken(request)).toBeNull();
  });

  it("returns null when bearer token is empty after trimming", () => {
    const request = new Request("http://localhost/api/sync/upload-url", {
      headers: { Authorization: "Bearer    " },
    });

    expect(readBearerToken(request)).toBeNull();
  });

  it("returns the trimmed bearer token", () => {
    const request = new Request("http://localhost/api/sync/upload-url", {
      headers: { Authorization: "Bearer  sync-token  " },
    });

    expect(readBearerToken(request)).toBe("sync-token");
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

  it("returns false when the configured token is missing", () => {
    configuredSyncToken = undefined;

    expect(verifySyncApiToken({ token: syncToken })).toBe(false);
  });

  it("returns false when the bearer token is missing", () => {
    expect(verifySyncApiToken({ token: null })).toBe(false);
  });

  it("returns false when the bearer token is wrong", () => {
    expect(verifySyncApiToken({ token: "wrong-token" })).toBe(false);
  });

  it("returns true when the bearer token matches the configured token", () => {
    expect(verifySyncApiToken({ token: syncToken })).toBe(true);
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

  it("returns null when the bearer token is valid", () => {
    const request = new Request("http://localhost/api/sync/upload-url", {
      headers: { Authorization: `Bearer ${syncToken}` },
    });

    expect(requireSyncApiToken(request)).toBeNull();
  });

  it("returns 401 when the bearer token is invalid", () => {
    const request = new Request("http://localhost/api/sync/upload-url", {
      headers: { Authorization: "Bearer wrong-token" },
    });

    const response = requireSyncApiToken(request);

    expect(response?.status).toBe(401);
  });
});

describe("assertSyncApiTokenFromBody", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
    resetSyncApiTokenDigestCacheForTests();
  });

  it("throws when the body token is invalid", () => {
    expect(() => assertSyncApiTokenFromBody("wrong-token")).toThrow("Invalid sync token.");
  });

  it("accepts a valid body token", () => {
    expect(() => assertSyncApiTokenFromBody(syncToken)).not.toThrow();
  });
});
