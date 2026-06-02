import { describe, expect, it } from "vitest";
import { planSignedOriginalDelivery } from "./delivery";

describe("media delivery planning", () => {
  it("plans content-addressed signed original delivery", () => {
    const sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    expect(
      planSignedOriginalDelivery({
        extension: "jpg",
        mediaType: "image",
        sha256,
      }),
    ).toEqual({
      expiresInSeconds: 60,
      objectKey: `originals/sha256/01/23/${sha256}.jpg`,
      strategy: "signed-url",
    });
  });
});
