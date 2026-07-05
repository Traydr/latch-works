import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCanvas: vi.fn(),
  destroy: vi.fn().mockResolvedValue(undefined),
  encode: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
  getContext: vi.fn(),
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getViewport: vi.fn(),
  renderPromise: vi.fn().mockResolvedValue(undefined),
  render: vi.fn(),
  cleanup: vi.fn(),
  resolve: vi.fn(),
  resolveWorker: vi.fn(),
  workerSrc: "",
}));

vi.mock("@napi-rs/canvas", () => ({
  createCanvas: mocks.createCanvas,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {
    get workerSrc() {
      return mocks.workerSrc;
    },
    set workerSrc(v: string) {
      mocks.workerSrc = v;
    },
  },
  InvalidPDFException: class InvalidPDFException extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InvalidPDFException";
    }
  },
}));

import { renderPdfCoverPage } from "./pdf.js";

const fakePdfBytes = Buffer.from("mock-pdf-bytes");

function setupSuccessfulRender(
  pageWidth = 612,
  pageHeight = 792,
): void {
  const fakeCtx = {};
  const fakeCanvas = {
    encode: mocks.encode,
    getContext: mocks.getContext.mockReturnValue(fakeCtx),
    height: pageHeight * 2,
    width: pageWidth * 2,
  };
  mocks.createCanvas.mockReturnValue(fakeCanvas);

  const fakeRenderTask = { promise: mocks.renderPromise() };
  mocks.render.mockReturnValue(fakeRenderTask);
  mocks.cleanup.mockReturnValue(undefined);

  const fakePage = {
    cleanup: mocks.cleanup,
    getViewport: mocks.getViewport.mockImplementation(({ scale }: { scale: number }) => ({
      height: pageHeight * scale,
      scale,
      width: pageWidth * scale,
    })),
    render: mocks.render,
  };
  mocks.getPage.mockResolvedValue(fakePage);

  const fakeDoc = {
    getPage: mocks.getPage,
    numPages: 1,
  };
  const fakeTask = {
    destroy: mocks.destroy,
    onPassword: undefined as unknown,
    promise: Promise.resolve(fakeDoc),
  };
  mocks.getDocument.mockReturnValue(fakeTask);
}

describe("renderPdfCoverPage", () => {
  it("rejects immediately when source bytes exceed the size limit", async () => {
    const oversized = Buffer.alloc(512 * 1024 * 1024 + 1);

    await expect(renderPdfCoverPage(oversized)).rejects.toThrow(/exceeds/);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("renders page 1 and returns PNG bytes for a valid PDF", async () => {
    setupSuccessfulRender();

    const result = await renderPdfCoverPage(fakePdfBytes);

    expect(mocks.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.any(Uint8Array) }),
    );
    expect(mocks.getPage).toHaveBeenCalledWith(1);
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: expect.any(Object) }),
    );
    expect(result).toEqual(Buffer.from("png-bytes"));
  });

  it("cleans up the loading task even when rendering succeeds", async () => {
    setupSuccessfulRender();

    await renderPdfCoverPage(fakePdfBytes);

    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("wraps and re-throws load failures from corrupt or invalid PDFs", async () => {
    const fakeTask = {
      destroy: mocks.destroy,
      onPassword: undefined as unknown,
      promise: Promise.reject(new Error("Invalid PDF structure.")),
    };
    mocks.getDocument.mockReturnValue(fakeTask);

    await expect(renderPdfCoverPage(fakePdfBytes)).rejects.toThrow(
      /PDF load failed.*Invalid PDF structure/,
    );
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("throws when the password callback is invoked for encrypted PDFs", async () => {
    let capturedOnPassword: (() => void) | undefined;
    const fakeTask = {
      destroy: mocks.destroy,
      set onPassword(fn: () => void) {
        capturedOnPassword = fn;
      },
      get onPassword(): (() => void) | undefined {
        return capturedOnPassword;
      },
      promise: new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          if (capturedOnPassword) {
            try {
              capturedOnPassword();
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error("onPassword not set"));
          }
        }, 10);
      }),
    };
    mocks.getDocument.mockReturnValue(fakeTask);

    await expect(renderPdfCoverPage(fakePdfBytes)).rejects.toThrow(/password-protected/);
    expect(mocks.destroy).toHaveBeenCalled();
  });

  it("throws when the PDF has no pages", async () => {
    const fakeDoc = { getPage: mocks.getPage, numPages: 0 };
    const fakeTask = {
      destroy: mocks.destroy,
      onPassword: undefined as unknown,
      promise: Promise.resolve(fakeDoc),
    };
    mocks.getDocument.mockReturnValue(fakeTask);

    await expect(renderPdfCoverPage(fakePdfBytes)).rejects.toThrow(/no pages/);
    expect(mocks.destroy).toHaveBeenCalled();
  });
});
