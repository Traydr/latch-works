import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@/lib/json";
import { postCompleteObject } from "../../routes/api.sync.complete-object";
import type { SyncRouteDependencies } from "./route-dependencies";
import type { CompleteObjectInput } from "./store";
import {
  validateSyncContentType,
  validateSyncLogicalPath,
  validateUploadFilename,
} from "./validation";

const ErrorBodySchema = z.object({ error: z.string() });

type UploadResult = { ok: true; input: CompleteObjectInput } | { ok: false; error: string };

function unused(): never {
  throw new Error("not reached by an upload");
}

/**
 * Posts an upload body through the complete-object route with a stub store:
 * a 400 carries the validation error, and a 200 carries the input the store
 * would have written.
 */
async function postUpload(body: JsonValue): Promise<UploadResult> {
  let stored: CompleteObjectInput | undefined;

  const dependencies: SyncRouteDependencies = {
    assertNoActiveCleanupJob: async () => undefined,
    completeSyncedObject: async ({ input }) => {
      stored = input;

      return { status: "database" };
    },
    createSignedUploadUrl: unused,
    finalizeSyncRun: unused,
    listRemoteSyncSnapshot: unused,
    markRemoteDeleted: unused,
    requireSyncApiToken: () => null,
    startSyncRun: unused,
  };

  const response = await postCompleteObject(
    {
      request: new Request("http://pane-view.test/api/sync/complete-object", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    },
    dependencies,
  );

  if (response.status === 400) {
    const { error } = ErrorBodySchema.parse(await response.json());

    return { ok: false, error };
  }

  if (!stored) {
    throw new Error(`unexpected ${response.status} response`);
  }

  return { ok: true, input: stored };
}

const validPayload = {
  contentType: "image/jpeg",
  extension: "jpg",
  filename: "cover.jpg",
  logicalPath: "photos/cover.jpg",
  mediaType: "image",
  mtimeMs: 1_700_000_000_000,
  sha256: "a".repeat(64),
  size: 128,
  syncRunId: "11111111-1111-4111-8111-111111111111",
};

describe("POST /api/sync/complete-object", () => {
  it("accepts a valid image ingest payload", async () => {
    const result = await postUpload(validPayload);
    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.input.logicalPath).toBe("photos/cover.jpg");
      expect(result.input.objectKey).toContain(validPayload.sha256);
    }
  });

  it("rejects unknown media", async () => {
    const result = await postUpload({ ...validPayload, mediaType: "unknown" });
    expect(result).toEqual({ ok: false, error: "unsupported media type" });
  });

  it("rejects invalid sha256 values", async () => {
    const result = await postUpload({ ...validPayload, sha256: "abc" });
    expect(result).toEqual({
      ok: false,
      error: "sha256 must be a 64-character hex string",
    });
  });

  it("rejects mismatched object keys", async () => {
    const result = await postUpload({
      ...validPayload,
      objectKey: "originals/sha256/00/00/wrong.jpg",
    });

    expect(result).toEqual({
      ok: false,
      error: "objectKey does not match derived storage key",
    });
  });

  it("rejects filename and logicalPath mismatches", async () => {
    const result = await postUpload({
      ...validPayload,
      filename: "other.jpg",
    });

    expect(result).toEqual({ ok: false, error: "filename must match logicalPath" });
  });

  it("rejects extension mismatches", async () => {
    const result = await postUpload({
      ...validPayload,
      extension: "png",
    });

    expect(result).toEqual({ ok: false, error: "extension must match filename" });
  });

  it("accepts jpeg extension aliases and stores them as jpg", async () => {
    const result = await postUpload({
      ...validPayload,
      extension: "jpeg",
      filename: "cover.jpeg",
      logicalPath: "photos/cover.jpeg",
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.input.extension).toBe("jpg");
      expect(result.input.objectKey).toBe(
        `originals/sha256/${validPayload.sha256.slice(0, 2)}/${validPayload.sha256.slice(2, 4)}/${validPayload.sha256}.jpg`,
      );
    }
  });

  it("rejects unsupported filenames even when fields are internally consistent", async () => {
    const result = await postUpload({
      ...validPayload,
      extension: "txt",
      filename: "notes.txt",
      logicalPath: "notes.txt",
      mediaType: "image",
    });

    expect(result).toEqual({ ok: false, error: "unsupported media filename" });
  });

  it("rejects mismatched content types", async () => {
    const result = await postUpload({
      ...validPayload,
      contentType: "image/png",
    });

    expect(result).toEqual({ ok: false, error: "contentType does not match extension" });
  });
});

describe("validateSyncContentType", () => {
  it("rejects mismatched content types", () => {
    expect(validateSyncContentType("jpg", "image/png")).toBe(
      "contentType does not match extension",
    );
    expect(validateSyncContentType("jpg", "image/jpeg")).toBeNull();
  });
});

describe("validateSyncLogicalPath", () => {
  it("rejects parent segments and trailing slashes", () => {
    expect(validateSyncLogicalPath("../outside.jpg")).toBe(
      "logicalPath must not contain parent segments",
    );
    expect(validateSyncLogicalPath("photos/")).toBe("logicalPath must not end with a slash");
  });
});

describe("validateUploadFilename", () => {
  it("rejects unsupported filenames", () => {
    expect(validateUploadFilename("notes.txt")).toBe("unsupported media filename");
    expect(validateUploadFilename("cover.jpg")).toBeNull();
  });
});
