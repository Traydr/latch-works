import { describe, expect, it } from "vitest";
import { canonicalizeExtension, normalizePathForCompare } from "./index.js";

describe("normalizePathForCompare", () => {
  it("folds case and path separators", () => {
    expect(normalizePathForCompare("SFW\\Photo.JPG")).toBe("sfw/photo.jpg");
  });

  it("treats jpeg and jpg as the same identity", () => {
    expect(normalizePathForCompare("sfw/photo.jpeg")).toBe(
      normalizePathForCompare("sfw/photo.jpg"),
    );
    expect(normalizePathForCompare("SFW/Photo.JPEG")).toBe("sfw/photo.jpg");
  });

  it("folds Unicode NFC and NFD spellings", () => {
    const nfc = "photos/café.jpg".normalize("NFC");
    const nfd = "photos/café.jpg".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(normalizePathForCompare(nfc)).toBe(normalizePathForCompare(nfd));
  });
});

describe("canonicalizeExtension", () => {
  it("aliases jpeg to jpg", () => {
    expect(canonicalizeExtension("JPEG")).toBe("jpg");
    expect(canonicalizeExtension(".jpeg")).toBe("jpg");
    expect(canonicalizeExtension("png")).toBe("png");
  });
});
