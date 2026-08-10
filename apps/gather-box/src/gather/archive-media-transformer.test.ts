import { describe, expect, it, vi } from "vitest";
import {
  type ArchiveMediaEncoders,
  createArchiveMediaTransformer
} from "./archive-media-transformer";

describe("archive media transformer", () => {
  it("dispatches still images and GIFs to their selected codecs", async () => {
    const encoders: ArchiveMediaEncoders = {
      encodeStillAsAvif: vi.fn(async () => new Uint8Array([1, 2]).buffer),
      encodeGifAsMp4: vi.fn(async () => new Uint8Array([3, 4]).buffer)
    };
    const transformer = createArchiveMediaTransformer(encoders);
    const signal = new AbortController().signal;

    const still = await transformer.transform(
      new Blob(["still"], { type: "image/png" }),
      "a.png",
      signal
    );
    const animation = await transformer.transform(
      new Blob(["animation"], { type: "image/gif" }),
      "b.gif",
      signal
    );

    expect(still).toMatchObject({ fileName: "a.avif", converted: true });
    expect(still.blob.type).toBe("image/avif");
    expect(animation).toMatchObject({ fileName: "b.mp4", converted: true });
    expect(animation.blob.type).toBe("video/mp4");
    expect(encoders.encodeStillAsAvif).toHaveBeenCalledWith(expect.any(Blob), signal);
    expect(encoders.encodeGifAsMp4).toHaveBeenCalledWith(expect.any(Blob), signal);
  });

  it("renames existing target formats and passes unrelated media through without a codec", async () => {
    const encoders = createEncoderSpies();
    const transformer = createArchiveMediaTransformer(encoders);
    const avif = new Blob(["avif"], { type: "image/avif" });
    const pdf = new Blob(["pdf"], { type: "application/pdf" });

    await expect(transformer.transform(avif, "stale.jpg")).resolves.toEqual({
      blob: avif,
      fileName: "stale.avif",
      converted: false
    });
    await expect(transformer.transform(pdf, "document.pdf")).resolves.toEqual({
      blob: pdf,
      fileName: "document.pdf",
      converted: false
    });
    expect(encoders.encodeStillAsAvif).not.toHaveBeenCalled();
    expect(encoders.encodeGifAsMp4).not.toHaveBeenCalled();
  });

  it("serializes codec work without blocking passthrough media", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const encode = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (encode.mock.calls.length === 1) {
        firstStarted();
        await firstGate;
      }
      active -= 1;
      return new ArrayBuffer(1);
    });
    const transformer = createArchiveMediaTransformer({
      encodeStillAsAvif: encode,
      encodeGifAsMp4: encode
    });

    const first = transformer.transform(new Blob([], { type: "image/png" }), "first.png");
    await firstStartedGate;
    const second = transformer.transform(new Blob([], { type: "image/gif" }), "second.gif");
    const pdf = new Blob([], { type: "application/pdf" });

    await expect(transformer.transform(pdf, "document.pdf")).resolves.toMatchObject({ blob: pdf });
    expect(encode).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("propagates a codec failure and keeps the conversion queue usable", async () => {
    const encodeStillAsAvif = vi
      .fn<ArchiveMediaEncoders["encodeStillAsAvif"]>()
      .mockRejectedValueOnce(new Error("encode failed"))
      .mockResolvedValueOnce(new ArrayBuffer(1));
    const transformer = createArchiveMediaTransformer({
      encodeStillAsAvif,
      encodeGifAsMp4: vi.fn(async () => new ArrayBuffer(1))
    });

    await expect(
      transformer.transform(new Blob([], { type: "image/png" }), "first.png")
    ).rejects.toThrow("encode failed");
    await expect(
      transformer.transform(new Blob([], { type: "image/png" }), "second.png")
    ).resolves.toMatchObject({ fileName: "second.avif", converted: true });
  });
});

function createEncoderSpies(): ArchiveMediaEncoders {
  return {
    encodeStillAsAvif: vi.fn(async () => new ArrayBuffer(1)),
    encodeGifAsMp4: vi.fn(async () => new ArrayBuffer(1))
  };
}
