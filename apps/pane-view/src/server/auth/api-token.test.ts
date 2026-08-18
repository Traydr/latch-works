import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSyncApiTokenFromBody,
  createSyncApiTokenVerifier,
  hashApiToken,
  readBearerToken,
  requireSyncApiToken,
  verifySyncApiToken,
} from "./api-token";

const syncToken = "test-sync-token-value";
let configuredSyncToken: string | undefined = syncToken;

/**
 * Stands in for the process-wide verifier, which reads PANE_VIEW_SYNC_TOKEN.
 * The guards take a verifier, so the suite controls the configured token
 * without touching the environment.
 */
const verifier = createSyncApiTokenVerifier({
  getConfiguredToken: () => configuredSyncToken,
});

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
  });

  it("accepts only an exact match against a configured token", () => {
    expect(verifySyncApiToken({ token: syncToken }, verifier)).toBe(true);
    expect(verifySyncApiToken({ token: "wrong-token" }, verifier)).toBe(false);
    expect(verifySyncApiToken({ token: null }, verifier)).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    configuredSyncToken = undefined;

    expect(verifySyncApiToken({ token: syncToken }, verifier)).toBe(false);
  });

  it("caches the configured token digest across requests", () => {
    const digest = vi.fn((token: string) => crypto.createHash("sha256").update(token).digest());
    const verifier = createSyncApiTokenVerifier({
      digest,
      getConfiguredToken: () => syncToken,
    });

    expect(verifier.verify({ token: "wrong-token" })).toBe(false);
    expect(verifier.verify({ token: syncToken })).toBe(true);
    expect(digest.mock.calls.filter(([token]) => token === syncToken)).toHaveLength(2);
  });
});

describe("requireSyncApiToken", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
  });

  it("passes a valid bearer token through and 401s an invalid one", () => {
    expect(requireSyncApiToken(syncRequest(`Bearer ${syncToken}`), verifier)).toBeNull();
    expect(requireSyncApiToken(syncRequest("Bearer wrong-token"), verifier)?.status).toBe(401);
  });
});

describe("assertSyncApiTokenFromBody", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
  });

  it("accepts a valid body token and throws on an invalid one", () => {
    expect(() => assertSyncApiTokenFromBody(syncToken, verifier)).not.toThrow();
    expect(() => assertSyncApiTokenFromBody("wrong-token", verifier)).toThrow(
      "Invalid sync token.",
    );
  });
});
