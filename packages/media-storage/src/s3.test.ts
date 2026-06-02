import { describe, expect, it } from "vitest";
import { readS3StorageConfig } from "./s3.js";

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
