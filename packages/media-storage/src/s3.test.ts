import { describe, expect, it } from "vitest";
import { createSignedPutUrl, createS3StorageClient, readS3StorageConfig } from "./s3.js";

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
