import { describe, expect, it } from "vitest";
import { buildCdnDeliveryPath, createDeliveryTokenSigner } from "./token.js";

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

  it("builds a CDN delivery path", () => {
    expect(buildCdnDeliveryPath("abc.def")).toBe("/cdn/v1/abc.def");
  });
});
