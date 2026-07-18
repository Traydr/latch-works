import { describe, expect, it } from "vitest";
import { canonicalizeExtension, createSyncPathIdentity, normalizePathForCompare } from "./index.js";

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

  it("can skip extension aliasing", () => {
    expect(normalizePathForCompare("sfw/photo.jpeg", { canonicalizeExtensions: false })).toBe(
      "sfw/photo.jpeg",
    );
    expect(normalizePathForCompare("sfw/photo.jpeg", { canonicalizeExtensions: false })).not.toBe(
      normalizePathForCompare("sfw/photo.jpg", { canonicalizeExtensions: false }),
    );
  });

  it("folds Unicode NFC and NFD spellings", () => {
    const nfc = "photos/café.jpg".normalize("NFC");
    const nfd = "photos/café.jpg".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(normalizePathForCompare(nfc)).toBe(normalizePathForCompare(nfd));
  });
});

describe("createSyncPathIdentity", () => {
  it("aliases jpeg across machines when there is no collision", () => {
    const identity = createSyncPathIdentity(["photos/sunset.jpeg"], ["photos/sunset.jpg"]);
    expect(identity("photos/sunset.jpeg")).toBe(identity("photos/sunset.jpg"));
  });

  it("keeps jpg and jpeg distinct when both exist on one side", () => {
    const identity = createSyncPathIdentity(
      ["photos/photo.jpg", "photos/photo.jpeg"],
      ["photos/photo.jpg", "photos/photo.jpeg"],
    );
    expect(identity("photos/photo.jpg")).not.toBe(identity("photos/photo.jpeg"));
    expect(identity("photos/photo.jpg")).toBe("photos/photo.jpg");
    expect(identity("photos/photo.jpeg")).toBe("photos/photo.jpeg");
  });
});

describe("canonicalizeExtension", () => {
  it("aliases jpeg to jpg", () => {
    expect(canonicalizeExtension("JPEG")).toBe("jpg");
    expect(canonicalizeExtension(".jpeg")).toBe("jpg");
    expect(canonicalizeExtension("png")).toBe("png");
  });
});
