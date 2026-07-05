import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStoredObject: vi.fn(),
  headStoredObject: vi.fn(),
  readStoredObjectBytes: vi.fn(),
  renderPdfCoverPage: vi.fn(),
}));

vi.mock("@latch-works/media-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@latch-works/media-storage")>();
  return {
    ...actual,
    getStoredObject: mocks.getStoredObject,
    headStoredObject: mocks.headStoredObject,
    readStoredObjectBytes: mocks.readStoredObjectBytes,
  };
});

vi.mock("ffmpeg-static", () => ({ default: "/usr/bin/ffmpeg" }));

vi.mock("./pdf.js", () => ({
  renderPdfCoverPage: mocks.renderPdfCoverPage,
}));

vi.mock("sharp", () => {
  const sharpFn = vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ height: 120, width: 160 }),
    resize: vi.fn().mockReturnThis(),
    rotate: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue({
      data: Buffer.from("webp"),
      info: { height: 120, width: 160 },
    }),
    webp: vi.fn().mockReturnThis(),
  }));

  return { default: sharpFn };
});

import { generateDerivativeBytes } from "./generate.js";

const sha256 = "a".repeat(64);
const storage = {} as never;

function mockHead(contentLength: number) {
  return { contentLength, contentType: "image/jpeg", etag: '"etag"' };
}

describe("generateDerivativeBytes (image)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resizes an image source under the size guard", async () => {
    const bytes = Buffer.from("source-image");
    mocks.headStoredObject.mockResolvedValue(mockHead(bytes.byteLength));
    mocks.readStoredObjectBytes.mockResolvedValue(bytes);

    const result = await generateDerivativeBytes({
      size: 320,
      source: { extension: "jpg", mediaType: "image", originalObjectKey: "objects/abc", sha256 },
      storage,
    });

    expect(result).toEqual({ bytes: Buffer.from("webp"), height: 120, width: 160 });
    expect(mocks.getStoredObject).not.toHaveBeenCalled();
  });

  it("rejects oversized image sources before buffering", async () => {
    mocks.headStoredObject.mockResolvedValue(mockHead(512 * 1024 * 1024 + 1));

    await expect(
      generateDerivativeBytes({
        size: 320,
        source: { extension: "jpg", mediaType: "image", originalObjectKey: "objects/abc", sha256 },
        storage,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(mocks.readStoredObjectBytes).not.toHaveBeenCalled();
  });

  it("rejects missing image sources", async () => {
    mocks.headStoredObject.mockResolvedValue(null);

    await expect(
      generateDerivativeBytes({
        size: 320,
        source: { extension: "jpg", mediaType: "image", originalObjectKey: "objects/abc", sha256 },
        storage,
      }),
    ).rejects.toThrow(/missing/);
  });
});

describe("generateDerivativeBytes (pdf)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.renderPdfCoverPage.mockResolvedValue(Buffer.from("cover-png"));
  });

  it("fetches, renders, and resizes a PDF cover page", async () => {
    const pdfBytes = Buffer.from("pdf-source");
    mocks.headStoredObject.mockResolvedValue(mockHead(pdfBytes.byteLength));
    mocks.readStoredObjectBytes.mockResolvedValue(pdfBytes);

    const result = await generateDerivativeBytes({
      size: 320,
      source: {
        extension: "pdf",
        mediaType: "pdf",
        originalObjectKey: "originals/doc.pdf",
        sha256,
      },
      storage,
    });

    expect(mocks.renderPdfCoverPage).toHaveBeenCalledWith(pdfBytes, expect.any(Number));
    expect(result).toEqual({ bytes: Buffer.from("webp"), height: 120, width: 160 });
  });

  it("rejects oversized PDF sources before downloading", async () => {
    mocks.headStoredObject.mockResolvedValue(mockHead(512 * 1024 * 1024 + 1));

    await expect(
      generateDerivativeBytes({
        size: 320,
        source: {
          extension: "pdf",
          mediaType: "pdf",
          originalObjectKey: "originals/doc.pdf",
          sha256,
        },
        storage,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(mocks.readStoredObjectBytes).not.toHaveBeenCalled();
    expect(mocks.renderPdfCoverPage).not.toHaveBeenCalled();
  });

  it("rejects when the PDF source object is missing", async () => {
    mocks.headStoredObject.mockResolvedValue(null);

    await expect(
      generateDerivativeBytes({
        size: 320,
        source: {
          extension: "pdf",
          mediaType: "pdf",
          originalObjectKey: "originals/doc.pdf",
          sha256,
        },
        storage,
      }),
    ).rejects.toThrow(/missing/);
    expect(mocks.renderPdfCoverPage).not.toHaveBeenCalled();
  });

  it("propagates render failures from corrupt or encrypted PDFs", async () => {
    const pdfBytes = Buffer.from("bad-pdf");
    mocks.headStoredObject.mockResolvedValue(mockHead(pdfBytes.byteLength));
    mocks.readStoredObjectBytes.mockResolvedValue(pdfBytes);
    mocks.renderPdfCoverPage.mockRejectedValue(
      new Error("PDF load failed: Invalid PDF structure."),
    );

    await expect(
      generateDerivativeBytes({
        size: 320,
        source: {
          extension: "pdf",
          mediaType: "pdf",
          originalObjectKey: "originals/doc.pdf",
          sha256,
        },
        storage,
      }),
    ).rejects.toThrow(/Invalid PDF structure/);
  });
});

describe("generateDerivativeBytes (video)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams the original video and extracts a poster frame", async () => {
    const videoBytes = Buffer.from("video-bytes");
    mocks.getStoredObject.mockResolvedValue({
      body: Readable.from([videoBytes]),
      contentLength: videoBytes.byteLength,
      contentRange: undefined,
      contentType: "video/mp4",
      etag: '"etag"',
      statusCode: 200,
    });

    const result = await generateDerivativeBytes({
      ffmpegRunner: async (_binaryPath, args) => {
        const outputPath = args.at(-1);
        if (typeof outputPath === "string") {
          await writeFile(outputPath, Buffer.from("poster-jpg"));
        }
      },
      size: 320,
      source: { extension: "mp4", mediaType: "video", originalObjectKey: "objects/video", sha256 },
      storage,
    });

    expect(result).toEqual({ bytes: Buffer.from("webp"), height: 120, width: 160 });
    expect(mocks.readStoredObjectBytes).not.toHaveBeenCalled();
  });

  it("rejects oversized streamed sources before ffmpeg runs", async () => {
    mocks.getStoredObject.mockResolvedValue({
      body: Readable.from([Buffer.alloc(1024, 1)]),
      contentLength: 512 * 1024 * 1024 + 1,
      contentRange: undefined,
      contentType: "video/mp4",
      etag: '"etag"',
      statusCode: 200,
    });

    let ffmpegRan = false;
    await expect(
      generateDerivativeBytes({
        ffmpegRunner: async () => {
          ffmpegRan = true;
        },
        size: 320,
        source: {
          extension: "mp4",
          mediaType: "video",
          originalObjectKey: "objects/video",
          sha256,
        },
        storage,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(ffmpegRan).toBe(false);
  });
});
