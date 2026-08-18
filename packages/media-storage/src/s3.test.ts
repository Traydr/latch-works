import { Readable } from "node:stream";
import type {
  DeleteObjectCommandOutput,
  GetObjectCommandOutput,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageClient,
  createSignedPutUrl,
  deleteStoredObjectsBatch,
  getStoredObject,
  listStoredObjectSummariesByPrefix,
  readS3StorageConfig,
  type S3CommandStorage,
} from "./s3.js";

/** The SDK hands back a payload stream carrying the `SdkStream` transform helpers. */
const streamTransforms = {
  transformToByteArray: () => Promise.resolve(new Uint8Array()),
  transformToString: () => Promise.resolve(""),
  transformToWebStream: (): never => {
    throw new Error("not used by these tests");
  },
};

describe("S3 storage config", () => {
  it("returns null until all required env vars exist", () => {
    expect(readS3StorageConfig({ S3_BUCKET: "bucket" })).toBeNull();
  });
});

describe("presigned PUT URLs", () => {
  it("signs content length, content type, checksum, and sha metadata without hoisting", async () => {
    const storage = createS3StorageClient({
      accessKeyId: "key",
      bucket: "bucket",
      endpoint: "https://storage.invalid",
      region: "auto",
      secretAccessKey: "secret",
    });

    const sha256 = "a".repeat(64);
    const checksumSHA256 = Buffer.from(sha256, "hex").toString("base64");
    const result = await createSignedPutUrl({
      contentLength: 12,
      contentType: "image/png",
      key: `originals/sha256/00/00/${sha256}.png`,
      sha256,
      storage,
    });

    const signedHeaders = new URL(result.uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders.split(";")).toEqual(
      expect.arrayContaining([
        "content-length",
        "content-type",
        "x-amz-checksum-sha256",
        "x-amz-meta-sha256",
      ]),
    );
    expect(result.uploadUrl).not.toContain("x-amz-checksum-sha256=");
    expect(result.uploadUrl).not.toContain("x-amz-meta-sha256=");
    expect(result.uploadUrl).not.toContain("x-amz-checksum-crc32");
    expect(result.headers).toEqual({
      "Content-Length": "12",
      "Content-Type": "image/png",
      "x-amz-checksum-sha256": checksumSHA256,
      "x-amz-meta-sha256": sha256,
    });
  });

  it("rejects invalid sha256 values before signing", async () => {
    const storage = createS3StorageClient({
      accessKeyId: "key",
      bucket: "bucket",
      endpoint: "https://storage.invalid",
      region: "auto",
      secretAccessKey: "secret",
    });

    await expect(
      createSignedPutUrl({
        contentLength: 1,
        contentType: "image/png",
        key: "originals/bad.png",
        sha256: "not-a-hash",
        storage,
      }),
    ).rejects.toThrow();
  });
});

describe("S3 object inventory and deletion", () => {
  it("returns object keys and byte sizes with pagination", async () => {
    const listing: ListObjectsV2CommandOutput = {
      $metadata: {},
      Contents: [
        { Key: "thumbnails/a.webp", Size: 12 },
        { Key: undefined, Size: 99 },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-page",
    };
    const send = vi.fn(async () => listing);
    const storage: S3CommandStorage = { bucket: "bucket", client: { send } };

    await expect(
      listStoredObjectSummariesByPrefix({ prefix: "thumbnails/", storage }),
    ).resolves.toEqual({
      nextContinuationToken: "next-page",
      objects: [{ key: "thumbnails/a.webp", size: 12 }],
    });
  });

  it("caps concurrent delete requests", async () => {
    let active = 0;
    let maximum = 0;
    const send = vi.fn(async (): Promise<DeleteObjectCommandOutput> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { $metadata: {} };
    });
    const storage: S3CommandStorage = { bucket: "bucket", client: { send } };

    await expect(
      deleteStoredObjectsBatch({
        keys: Array.from({ length: 25 }, (_, index) => `previews/${index}.webp`),
        maxConcurrent: 10,
        storage,
      }),
    ).resolves.toEqual({ deleted: 25, errors: 0 });
    expect(maximum).toBe(10);
  });
});

describe("stored object bodies", () => {
  it("returns the Node stream body and the ranged status code", async () => {
    const body = Object.assign(Readable.from(["chunk"]), streamTransforms);
    const output: GetObjectCommandOutput = {
      $metadata: { httpStatusCode: 206 },
      Body: body,
      ContentRange: "bytes 0-4/5",
    };
    const storage: S3CommandStorage = {
      bucket: "bucket",
      client: { send: vi.fn(async () => output) },
    };

    await expect(
      getStoredObject({ key: "originals/a.png", range: "bytes=0-4", storage }),
    ).resolves.toEqual({
      body,
      contentLength: undefined,
      contentRange: "bytes 0-4/5",
      contentType: undefined,
      etag: undefined,
      statusCode: 206,
    });
  });

  it("rejects a payload that is not a Node stream", async () => {
    const output: GetObjectCommandOutput = {
      $metadata: {},
      Body: Object.assign(new Blob(["chunk"]), streamTransforms),
    };
    const storage: S3CommandStorage = {
      bucket: "bucket",
      client: { send: vi.fn(async () => output) },
    };

    await expect(getStoredObject({ key: "originals/a.png", storage })).rejects.toThrow(
      "S3 returned a non-Node stream body for key: originals/a.png",
    );
  });

  it("reports batch delete failures as Errors", async () => {
    const storage: S3CommandStorage = {
      bucket: "bucket",
      // A transport failure can surface as a non-Error rejection value.
      client: { send: vi.fn(() => Promise.reject("connection reset")) },
    };
    const failures: { key: string; message: string; name: string }[] = [];

    await expect(
      deleteStoredObjectsBatch({
        keys: ["previews/a.webp"],
        onError: (error, key) => failures.push({ key, message: error.message, name: error.name }),
        storage,
      }),
    ).resolves.toEqual({ deleted: 0, errors: 1 });
    expect(failures).toEqual([
      { key: "previews/a.webp", message: "connection reset", name: "Error" },
    ]);
  });
});
