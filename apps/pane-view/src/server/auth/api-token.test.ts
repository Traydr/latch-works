import { beforeEach, describe, expect, it } from "vitest";

import {
  assertSyncApiTokenFromBody,
  createSyncApiTokenVerifier,
  readBearerToken,
  requireSyncApiToken,
} from "./api-token";

const syncToken = "test-sync-token-value";

let configuredSyncToken: string | undefined = syncToken;

/**
 * Stands in for the process-wide verifier, which reads PANE_VIEW_SYNC_TOKEN.
 * The guards take a verifier, so the suite controls the configured token
 * without touching the environment.
 */
const verifier = createSyncApiTokenVerifier(() => configuredSyncToken);

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

describe("sync token verifier", () => {
  beforeEach(() => {
    configuredSyncToken = syncToken;
  });

  it("accepts only an exact match against a configured token", () => {
    expect(verifier.verify(syncToken)).toBe(true);
    expect(verifier.verify("wrong-token")).toBe(false);
    expect(verifier.verify(null)).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    configuredSyncToken = undefined;

    expect(verifier.verify(syncToken)).toBe(false);
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
