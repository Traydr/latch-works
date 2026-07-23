import { describe, expect, it } from "vitest";
import {
  validateSyncContentType,
  validateSyncLogicalPath,
  validateSyncObjectPayload,
  validateUploadFilename,
} from "./validation";

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

describe("validateSyncObjectPayload", () => {
  it("accepts a valid image ingest payload", () => {
    const result = validateSyncObjectPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.logicalPath).toBe("photos/cover.jpg");
      expect(result.input.objectKey).toContain(validPayload.sha256);
    }
  });

  it("rejects unknown media", () => {
    const result = validateSyncObjectPayload({ ...validPayload, mediaType: "unknown" });
    expect(result).toEqual({ ok: false, error: "unsupported media type" });
  });

  it("rejects invalid sha256 values", () => {
    const result = validateSyncObjectPayload({ ...validPayload, sha256: "abc" });
    expect(result).toEqual({
      ok: false,
      error: "sha256 must be a 64-character hex string",
    });
  });

  it("rejects mismatched object keys", () => {
    const result = validateSyncObjectPayload({
      ...validPayload,
      objectKey: "originals/sha256/00/00/wrong.jpg",
    });
    expect(result).toEqual({
      ok: false,
      error: "objectKey does not match derived storage key",
    });
  });

  it("rejects filename and logicalPath mismatches", () => {
    const result = validateSyncObjectPayload({
      ...validPayload,
      filename: "other.jpg",
    });
    expect(result).toEqual({ ok: false, error: "filename must match logicalPath" });
  });

  it("rejects extension mismatches", () => {
    const result = validateSyncObjectPayload({
      ...validPayload,
      extension: "png",
    });
    expect(result).toEqual({ ok: false, error: "extension must match filename" });
  });

  it("accepts jpeg extension aliases and stores them as jpg", () => {
    const result = validateSyncObjectPayload({
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

  it("rejects unsupported filenames even when fields are internally consistent", () => {
    const result = validateSyncObjectPayload({
      ...validPayload,
      extension: "txt",
      filename: "notes.txt",
      logicalPath: "notes.txt",
      mediaType: "image",
    });
    expect(result).toEqual({ ok: false, error: "unsupported media filename" });
  });

  it("rejects mismatched content types", () => {
    const result = validateSyncObjectPayload({
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
