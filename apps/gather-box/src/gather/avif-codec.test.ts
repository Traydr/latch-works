import { describe, expect, it, vi } from "vitest";
import { ARCHIVE_AVIF_OPTIONS, encodeWithAvifModule, type RgbaImage } from "./avif-codec";

describe("AVIF codec", () => {
  it("passes archive quality 70 and speed 6 to the encoder", () => {
    const encode = vi.fn(() => new Uint8Array([1, 2, 3]));
    const imageData: RgbaImage = {
      data: new Uint8ClampedArray([255, 0, 0, 255]),
      width: 1,
      height: 1
    };

    const result = encodeWithAvifModule(imageData, { encode });

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
    expect(encode).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      1,
      1,
      expect.objectContaining({ quality: 70, speed: 6 })
    );
    expect(ARCHIVE_AVIF_OPTIONS).toMatchObject({ quality: 70, speed: 6 });
  });
});
