import type { Canvas, createCanvas as CreateCanvas } from "@napi-rs/canvas";
import type {
  getDocument as GetDocument,
  GlobalWorkerOptions as GlobalWorkerOptionsType,
  InvalidPDFException,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { DEFAULT_MAX_SOURCE_BYTES } from "./descriptor.js";

/**
 * Maximum scale applied to a PDF page before rasterizing. A scale of 2.0
 * renders at 144 dpi (2× the default 72 dpi), which is sufficient for
 * derivative thumbnails and previews.
 */
const PDF_RENDER_SCALE = 2.0;

/**
 * Maximum pixel dimension (width or height) for the rasterized page. Pages
 * larger than this are downscaled via a reduced render scale to keep memory
 * bounded.
 */
const PDF_MAX_PIXEL_DIMENSION = 2400;

let workerInitialized = false;

async function initWorkerSrc(): Promise<void> {
  if (workerInitialized) {
    return;
  }

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    GlobalWorkerOptions: typeof GlobalWorkerOptionsType;
  };

  // Resolve the worker file URL relative to this module so it stays correct
  // regardless of how the package is installed.
  const workerUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  workerInitialized = true;
}

/**
 * Renders the first page of a PDF buffer to raw PNG bytes using pdfjs-dist
 * (legacy Node.js build) with @napi-rs/canvas as the canvas backend.
 *
 * Throws on:
 * - Oversized source (exceeds maxBytes)
 * - Invalid or corrupt PDF (InvalidPDFException)
 * - Password-protected PDF (PasswordException-like error from pdfjs-dist)
 * - Zero-page PDF
 */
export async function renderPdfCoverPage(
  pdfBytes: Buffer,
  maxBytes: number = DEFAULT_MAX_SOURCE_BYTES,
): Promise<Buffer> {
  if (pdfBytes.byteLength > maxBytes) {
    throw new Error(`PDF source exceeds ${maxBytes} bytes`);
  }

  await initWorkerSrc();

  const { createCanvas } = (await import("@napi-rs/canvas")) as {
    createCanvas: typeof CreateCanvas;
  };

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument: typeof GetDocument;
    InvalidPDFException: typeof InvalidPDFException;
  };

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useWorkerFetch: false,
  });

  loadingTask.onPassword = () => {
    throw new Error("PDF is password-protected and cannot be rendered");
  };

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    if (error instanceof Error) {
      throw new Error(`PDF load failed: ${error.message}`);
    }

    throw error;
  }

  try {
    if (doc.numPages < 1) {
      throw new Error("PDF has no pages");
    }

    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1.0 });

    const maxDim = Math.max(baseViewport.width, baseViewport.height);
    const scale =
      maxDim * PDF_RENDER_SCALE > PDF_MAX_PIXEL_DIMENSION
        ? PDF_MAX_PIXEL_DIMENSION / maxDim
        : PDF_RENDER_SCALE;

    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);

    const canvas: Canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    await page
      .render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      })
      .promise;

    page.cleanup();

    return await canvas.encode("png");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
