import { fileURLToPath } from "node:url";
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

// Narrow structural type for the canvas returned by pdfjs's NodeCanvasFactory.
// We only need encode(); pdfjs owns the full object so we never create one
// ourselves.
interface NodeCanvas {
  encode(format: string): Promise<Buffer>;
}

// pdfjs types canvasFactory as Object; cast to access create().
interface PdfjsCanvasFactory {
  create(width: number, height: number): { canvas: NodeCanvas; context: CanvasRenderingContext2D };
}

/**
 * Renders the first page of a PDF buffer to raw PNG bytes using pdfjs-dist
 * (legacy Node.js build) with pdfjs's own built-in NodeCanvasFactory.
 *
 * All canvas/context/Path2D objects come from pdfjs's internal @napi-rs/canvas
 * instance. Importing @napi-rs/canvas separately would produce a second native
 * module instance whose objects cannot mix with pdfjs's, causing napi
 * type-mismatch errors on vector path fills and glyph rendering.
 *
 * Throws on:
 * - Oversized source (exceeds maxBytes)
 * - Invalid or corrupt PDF
 * - Password-protected PDF
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

  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
    getDocument: typeof GetDocument;
    InvalidPDFException: typeof InvalidPDFException;
  };

  // Resolve the standard_fonts directory from the installed pdfjs-dist package.
  // A filesystem path is required; pdfjs in Node.js does not accept a file://
  // URL for standardFontDataUrl.
  const standardFontDataUrl = fileURLToPath(
    new URL("./standard_fonts/", import.meta.resolve("pdfjs-dist/package.json")),
  );

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    standardFontDataUrl,
    useSystemFonts: false,
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

    // Use pdfjs's own canvas factory so every canvas/context/Path2D comes from
    // the same @napi-rs/canvas instance that pdfjs loaded internally. Creating
    // a canvas from a separately imported @napi-rs/canvas instance would cause
    // napi type-mismatch errors when pdfjs passes Path2D objects into ctx.fill()
    // on PDFs with vector fills or glyph paths.
    const canvasFactory = doc.canvasFactory as unknown as PdfjsCanvasFactory;
    const { canvas } = canvasFactory.create(width, height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;

    page.cleanup();

    return await canvas.encode("png");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
