import { describe, expect, it } from "vitest";
import { createGalleryRandomSeed } from "@/features/gallery/gallery-random-seed";
import {
  type GalleryRandomSeed,
  GalleryRandomSeedSchema,
} from "@/features/library/listing-contract";
import { galleryRandomOrderKey } from "./gallery-order";

const SEED: GalleryRandomSeed = "0123456789abcdef0123456789abcdef";

describe("galleryRandomOrderKey", () => {
  it("is 32 lowercase hex characters", () => {
    const key = galleryRandomOrderKey(SEED, "media", "x");
    expect(key).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("keys media and comics separately even for the same id", () => {
    expect(galleryRandomOrderKey(SEED, "media", "x")).not.toBe(
      galleryRandomOrderKey(SEED, "comic", "x"),
    );
  });
});

describe("gallery random seed", () => {
  it("validates 32 lowercase hex characters only", () => {
    const isSeed = (value: string | number | null) =>
      GalleryRandomSeedSchema.safeParse(value).success;

    expect(isSeed("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSeed("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(isSeed("0123456789abcdef0123456789abcde")).toBe(false);
    expect(isSeed(42)).toBe(false);
    expect(isSeed(null)).toBe(false);
  });

  it("creates 32 lowercase hex characters", () => {
    expect(GalleryRandomSeedSchema.safeParse(createGalleryRandomSeed()).success).toBe(true);
  });
});
