import { describe, expect, it, vi } from "vitest";
import {
  createS3StorageClient,
  createSignedPutUrl,
  deleteStoredObjectsBatch,
  listStoredObjectSummariesByPrefix,
  readS3StorageConfig,
  type S3StorageClient,
} from "./s3.js";

describe("S3 storage config", () => {
  it("returns null until all required env vars exist", () => {
    expect(readS3StorageConfig({ S3_BUCKET: "bucket" })).toBeNull();
  });

  it("reads S3-compatible storage config", () => {
    expect(
      readS3StorageConfig({
        S3_ACCESS_KEY_ID: "key",
        S3_BUCKET: "bucket",
        S3_ENDPOINT: "https://storage.invalid",
        S3_REGION: "auto",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      accessKeyId: "key",
      bucket: "bucket",
      endpoint: "https://storage.invalid",
      region: "auto",
      secretAccessKey: "secret",
    });
  });
});

describe("presigned PUT URLs", () => {
  it("does not embed automatic checksum query params", async () => {
    const storage = createS3StorageClient({
      accessKeyId: "key",
      bucket: "bucket",
      endpoint: "https://storage.invalid",
      region: "auto",
      secretAccessKey: "secret",
    });

    const uploadUrl = await createSignedPutUrl({
      contentType: "image/png",
      key: "originals/sha256/00/00/test.png",
      storage,
    });

    expect(uploadUrl).not.toContain("x-amz-checksum-crc32");
    expect(uploadUrl).not.toContain("x-amz-sdk-checksum-algorithm");
  });
});

describe("S3 object inventory and deletion", () => {
  it("returns object keys and byte sizes with pagination", async () => {
    const send = vi.fn().mockResolvedValue({
      Contents: [
        { Key: "thumbnails/a.webp", Size: 12 },
        { Key: undefined, Size: 99 },
      ],
      IsTruncated: true,
      NextContinuationToken: "next-page",
    });
    const storage = { bucket: "bucket", client: { send } } as unknown as S3StorageClient;

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
    const send = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {};
    });
    const storage = { bucket: "bucket", client: { send } } as unknown as S3StorageClient;

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
