/**
 * The slice of pdf.js the document viewer uses. Keeping it behind an interface
 * lets the viewer render against a fake document while the real adapter below
 * owns the dynamic import and the worker URL.
 */

export interface PdfViewport {
  height: number;
  width: number;
}

export interface PdfRenderTask {
  cancel(): void;
  promise: Promise<void>;
}

export interface PdfPageRenderOptions {
  canvas: HTMLCanvasElement | null;
  canvasContext?: CanvasRenderingContext2D;
  transform?: number[];
  viewport: PdfViewport;
}

export interface PdfPage {
  cleanup(): void;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: PdfPageRenderOptions): PdfRenderTask;
}

export interface PdfDocumentHandle {
  getPage(pageNumber: number): Promise<PdfPage>;
  numPages: number;
}

export interface PdfLoadingTask {
  destroy(): void;
  promise: Promise<PdfDocumentHandle>;
}

export interface PdfEngine {
  /** Starts loading one document; cancelling means destroying the returned task. */
  openDocument(url: string): Promise<PdfLoadingTask>;
}

export const pdfjsEngine: PdfEngine = {
  async openDocument(url) {
    const [pdfjs, workerModule] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);

    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    return pdfjs.getDocument({ url });
  },
};
