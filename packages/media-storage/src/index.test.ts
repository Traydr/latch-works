import { describe, expect, it } from "vitest";
import { originalObjectKey } from "./index.js";

const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("media-storage", () => {
  it("uses content-addressed original keys without mediaType", () => {
    expect(originalObjectKey({ extension: ".JPG", sha256: hash })).toBe(
      `originals/sha256/01/23/${hash}.jpg`,
    );
  });
});
