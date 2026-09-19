import { describe, expect, it } from "vitest";
import {
  type ArchiveMediaEncoders,
  createArchiveMediaTransformer
} from "./archive-media-transformer";
import { MediaEncodeError } from "./errors";

const ENCODED_BYTES = new Uint8Array([1, 2, 3]).buffer;

function createEncoders(encodeStillAsAvif: ArchiveMediaEncoders["encodeStillAsAvif"]) {
  return {
    encodeStillAsAvif,
    encodeGifAsMp4: async () => ENCODED_BYTES
  } satisfies ArchiveMediaEncoders;
}

describe("archive media transformer", () => {
  it("converts a still image to AVIF", async () => {
    const transformer = createArchiveMediaTransformer(createEncoders(async () => ENCODED_BYTES));
    const source = new Blob(["png bytes"], { type: "image/png" });

    const transformed = await transformer.transform(source, "photo.png");

    expect(transformed.fileName).toBe("photo.avif");
    expect(transformed.converted).toBe(true);
    expect(transformed.blob.type).toBe("image/avif");
  });

  it("keeps the original when the encoder cannot handle the image", async () => {
    const transformer = createArchiveMediaTransformer(
      createEncoders(async () => {
        throw new MediaEncodeError("memory access out of bounds");
      })
    );

    const source = new Blob(["png bytes"], { type: "image/png" });
    const transformed = await transformer.transform(source, "huge.png");

    expect(transformed).toEqual({
      blob: source,
      fileName: "huge.png",
      converted: false,
      conversionFailure: "memory access out of bounds"
    });
  });

  it("fails the item when the image itself cannot be read", async () => {
    const transformer = createArchiveMediaTransformer(
      createEncoders(async () => {
        throw new Error("The source image could not be decoded.");
      })
    );

    await expect(
      transformer.transform(new Blob(["not a png"], { type: "image/png" }), "broken.png")
    ).rejects.toThrow("The source image could not be decoded.");
  });
});
