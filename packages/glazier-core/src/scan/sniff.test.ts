import { describe, expect, it } from "vitest";

import { isExtensionMismatch, sniffBytes } from "./sniff.js";

function bytes(...parts: Array<string | number[]>): Buffer {
  return Buffer.concat(
    parts.map((part) => (Array.isArray(part) ? Buffer.from(part) : Buffer.from(part, "latin1"))),
  );
}

function ftyp(major: string, ...compatible: string[]): Buffer {
  const body = bytes(major, [0, 0, 0, 0], ...compatible);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length);

  return bytes([...size], "ftyp", [...body]);
}

describe("format sniffing", () => {
  it("names images by their signatures", () => {
    expect(sniffBytes(bytes([0x89], "PNG\r\n\u001a\n"))).toBe("png");
    expect(sniffBytes(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffBytes(bytes("GIF89a"))).toBe("gif");
    expect(sniffBytes(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("webp");
    expect(sniffBytes(ftyp("avif", "mif1", "miaf"))).toBe("avif");
    expect(sniffBytes(ftyp("mif1", "avif"))).toBe("avif");
    expect(sniffBytes(ftyp("heic", "mif1"))).toBe("heic");
  });

  it("tells MP4 from QuickTime and WebM from Matroska", () => {
    expect(sniffBytes(ftyp("isom", "iso2", "avc1", "mp41"))).toBe("mp4");
    expect(sniffBytes(ftyp("qt  ", "qt  "))).toBe("mov");
    expect(sniffBytes(bytes([0x1a, 0x45, 0xdf, 0xa3], "....B\u0082\u0084webm"))).toBe("webm");
    expect(sniffBytes(bytes([0x1a, 0x45, 0xdf, 0xa3], "....B\u0082\u0088matroska"))).toBe(
      "matroska",
    );
  });

  it("flags extensions that do not name the bytes", () => {
    expect(isExtensionMismatch("avif", "jpg")).toBe(true);
    expect(isExtensionMismatch("jpeg", "JPEG")).toBe(false);
    expect(isExtensionMismatch("mp4", "m4v")).toBe(false);
    expect(isExtensionMismatch("unknown", "dat")).toBe(false);
  });

  it("calls an archive's extension wrong only when it names another format", () => {
    expect(isExtensionMismatch("zip", "zipmod")).toBe(false);
    expect(isExtensionMismatch("rar", "r00")).toBe(false);
    expect(isExtensionMismatch("7z", "001")).toBe(false);
    expect(isExtensionMismatch("zip", "jpg")).toBe(true);
    expect(isExtensionMismatch("rar", "cbz")).toBe(true);
  });
});
