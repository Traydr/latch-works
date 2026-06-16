import { describe, expect, it } from "vitest";
import {
  buildCdnDeliveryPath,
  createDeliveryTokenSigner,
  readDeliveryTokenExpiration,
} from "./token.js";

describe("delivery token", () => {
  const signer = createDeliveryTokenSigner("test-secret");

  it("round-trips a valid token", () => {
    const token = signer.sign({
      exp: Math.floor(Date.now() / 1000) + 3600,
      objectKey: "thumbnails/sha256/ab/cd/hash-320.webp",
      purpose: "thumbnail",
    });

    expect(signer.verify(token)).toEqual({
      exp: expect.any(Number),
      objectKey: "thumbnails/sha256/ab/cd/hash-320.webp",
      purpose: "thumbnail",
    });
  });

  it("rejects tampered tokens", () => {
    const token = signer.sign({
      exp: Math.floor(Date.now() / 1000) + 3600,
      objectKey: "thumbnails/sha256/ab/cd/hash-320.webp",
      purpose: "thumbnail",
    });

    expect(signer.verify(`${token}x`)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = signer.sign({
      exp: Math.floor(Date.now() / 1000) - 10,
      objectKey: "thumbnails/sha256/ab/cd/hash-320.webp",
      purpose: "thumbnail",
    });

    expect(signer.verify(token)).toBeNull();
  });

  it("round-trips an original-purpose token", () => {
    const token = signer.sign({
      exp: Math.floor(Date.now() / 1000) + 3600,
      objectKey: "originals/sha256/ab/cd/hash.jpg",
      purpose: "original",
    });

    expect(signer.verify(token)).toEqual({
      exp: expect.any(Number),
      objectKey: "originals/sha256/ab/cd/hash.jpg",
      purpose: "original",
    });
  });

  it("builds a CDN delivery path", () => {
    expect(buildCdnDeliveryPath("abc.def")).toBe("/cdn/v1/abc.def");
  });
});

describe("readDeliveryTokenExpiration", () => {
  const ttlSeconds = 86_400;

  it("keeps the same exp within a ttl bucket", () => {
    expect(readDeliveryTokenExpiration(100_000, ttlSeconds)).toBe(
      readDeliveryTokenExpiration(100_001, ttlSeconds),
    );
  });

  it("advances exp across bucket boundaries", () => {
    expect(readDeliveryTokenExpiration(172_799, ttlSeconds)).toBe(172_800);
    expect(readDeliveryTokenExpiration(172_800, ttlSeconds)).toBe(259_200);
  });
});
