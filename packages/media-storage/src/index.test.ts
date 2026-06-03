import { describe, expect, it } from "vitest";
import {
  originalObjectKey,
  previewObjectKey,
  syncRunManifestKey,
  thumbnailObjectKey,
} from "./index.js";

const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("media-storage", () => {
  it("uses content-addressed original keys", () => {
    expect(originalObjectKey({ extension: ".JPG", mediaType: "image", sha256: hash })).toBe(
      `originals/sha256/01/23/${hash}.jpg`,
    );
  });

  it("uses derived preview key spaces", () => {
    expect(
      thumbnailObjectKey({ extension: "jpg", mediaType: "image", sha256: hash, size: 320 }),
    ).toBe(`thumbnails/sha256/01/23/${hash}-320.webp`);
    expect(previewObjectKey({ extension: "pdf", mediaType: "pdf", sha256: hash, size: 900 })).toBe(
      `previews/pdf/sha256/01/23/${hash}-900.webp`,
    );
  });

  it("names sync manifests by run id", () => {
    expect(syncRunManifestKey("run_123")).toBe("manifests/sync-runs/run_123.jsonl");
  });
});
