import { readVectors } from "@latch-works/conformance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@/lib/json";
import type { CompleteObjectInput } from "./store";
import {
  type ParsedSyncBody,
  parseCompleteObjectBody,
  parseCreateSyncRunBody,
  parseFinalizeSyncRunBody,
  parseSyncLogicalPath,
  parseUploadUrlBody,
} from "./validation";

/** The bodies the Lockstep clients send, as lockstep-core's conformance suite writes them. */
const WireVectorsSchema = z.object({
  createRun: z.json(),
  delete: z.json(),
  finalize: z.array(z.object({ body: z.json(), name: z.string() })),
  registrations: z.array(
    z.object({
      completeObject: z.json(),
      name: z.string(),
      uploadUrl: z.json(),
    }),
  ),
});

const wire = readVectors({ set: "lockstep-core", name: "wire.json" }, WireVectorsSchema);

const RegisteredObjectSchema = z.object({ logicalPath: z.string(), objectKey: z.string() });

describe("the bodies Lockstep sends", () => {
  it.each(wire.registrations)("$name", ({ completeObject, uploadUrl }) => {
    const { logicalPath, objectKey } = RegisteredObjectSchema.parse(completeObject);

    expect(parseUploadUrlBody(uploadUrl)).toMatchObject({ ok: true, body: { objectKey } });
    expect(parseCompleteObjectBody(completeObject)).toMatchObject({
      ok: true,
      body: { action: "upload", logicalPath, objectKey },
    });
  });

  it("a remote delete", () => {
    expect(parseCompleteObjectBody(wire.delete)).toMatchObject({
      ok: true,
      body: { action: "delete" },
    });
  });

  it("a run start", () => {
    expect(parseCreateSyncRunBody(wire.createRun).ok).toBe(true);
  });

  it.each(wire.finalize)("finalizing $name", ({ body }) => {
    expect(parseFinalizeSyncRunBody(body).ok).toBe(true);
  });
});

const sha256 = "a".repeat(64);

const validPayload = {
  contentType: "image/jpeg",
  extension: "jpg",
  filename: "cover.jpg",
  logicalPath: "photos/cover.jpg",
  mediaType: "image",
  mtimeMs: 1_700_000_000_000,
  objectKey: `originals/sha256/aa/aa/${sha256}.jpg`,
  sha256,
  size: 128,
  syncRunId: "11111111-1111-4111-8111-111111111111",
};

function parseUpload(body: JsonValue): ParsedSyncBody<CompleteObjectInput> {
  const parsed = parseCompleteObjectBody(body);

  if (!parsed.ok) return parsed;

  if (parsed.body.action === "delete") {
    throw new Error("an upload parsed as a delete");
  }

  return { ok: true, body: parsed.body };
}

describe("POST /api/sync/complete-object", () => {
  it("rejects unknown media", () => {
    const result = parseUpload({ ...validPayload, mediaType: "unknown" });
    expect(result).toEqual({ ok: false, error: "unsupported media type" });
  });

  it("rejects invalid sha256 values", () => {
    const result = parseUpload({ ...validPayload, sha256: "abc" });
    expect(result).toEqual({
      ok: false,
      error: "sha256 must be a 64-character hex string",
    });
  });

  it("stores an uppercase sha256 in its canonical lowercase spelling", () => {
    const mixedCase = "Ab".repeat(32);

    const result = parseUpload({
      ...validPayload,
      objectKey: `originals/sha256/ab/ab/${mixedCase.toLowerCase()}.jpg`,
      sha256: mixedCase,
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body.sha256).toBe(mixedCase.toLowerCase());
    }
  });

  it("rejects mismatched object keys", () => {
    const result = parseUpload({
      ...validPayload,
      objectKey: "originals/sha256/00/00/wrong.jpg",
    });

    expect(result).toEqual({
      ok: false,
      error: "objectKey does not match derived storage key",
    });
  });

  it("rejects filename and logicalPath mismatches", () => {
    const result = parseUpload({
      ...validPayload,
      filename: "other.jpg",
    });

    expect(result).toEqual({ ok: false, error: "filename must match logicalPath" });
  });

  it("rejects extension mismatches", () => {
    const result = parseUpload({
      ...validPayload,
      extension: "png",
    });

    expect(result).toEqual({ ok: false, error: "extension must match filename" });
  });

  it("accepts jpeg extension aliases and stores them as jpg", () => {
    const result = parseUpload({
      ...validPayload,
      extension: "jpeg",
      filename: "cover.jpeg",
      logicalPath: "photos/cover.jpeg",
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.body.extension).toBe("jpg");
      expect(result.body.objectKey).toBe(
        `originals/sha256/${validPayload.sha256.slice(0, 2)}/${validPayload.sha256.slice(2, 4)}/${validPayload.sha256}.jpg`,
      );
    }
  });

  it("rejects unsupported filenames even when fields are internally consistent", () => {
    const result = parseUpload({
      ...validPayload,
      extension: "txt",
      filename: "notes.txt",
      logicalPath: "notes.txt",
      mediaType: "image",
    });

    expect(result).toEqual({ ok: false, error: "unsupported media filename" });
  });

  it("rejects mismatched content types", () => {
    const result = parseUpload({
      ...validPayload,
      contentType: "image/png",
    });

    expect(result).toEqual({ ok: false, error: "contentType does not match extension" });
  });
});

describe("parseSyncLogicalPath", () => {
  it("rejects parent segments", () => {
    expect(parseSyncLogicalPath("../outside.jpg")).toEqual({
      ok: false,
      error: "logicalPath must not contain parent segments",
    });
  });
});

describe("POST /api/sync/upload-url", () => {
  it("rejects unsupported filenames", () => {
    expect(
      parseUploadUrlBody({
        contentType: "text/plain",
        filename: "notes.txt",
        sha256: "a".repeat(64),
        size: 1,
      }),
    ).toEqual({ ok: false, error: "unsupported media filename" });
  });
});
