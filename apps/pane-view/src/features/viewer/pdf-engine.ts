import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";

/**
 * The slice of pdf.js the document viewer uses. Keeping it behind an interface
 * lets the viewer render against a fake document while the real adapter below
 * owns the dynamic import, the worker URL, and pdf.js's viewport objects.
 */

interface PdfViewport {
  height: number;
  width: number;
}

export interface PdfRenderTask {
  cancel(): void;
  promise: Promise<void>;
}

interface PdfPageRenderOptions {
  canvas: HTMLCanvasElement;
  canvasContext: CanvasRenderingContext2D;
  scale: number;
  transform?: number[];
}

export interface PdfPage {
  cleanup(): void;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: PdfPageRenderOptions): PdfRenderTask;
  /**
   * Builds clickable overlays for the page's links at `scale`, or null when it has none. Web
   * links open in a new tab; links into the document hand their target page to `onPageLink`.
   */
  renderLinks(
    scale: number,
    onPageLink: (pageNumber: number) => void,
  ): Promise<HTMLDivElement | null>;
}

interface PdfDocumentHandle {
  getPage(pageNumber: number): Promise<PdfPage>;
  numPages: number;
}

interface PdfLoadingTask {
  destroy(): void;
  promise: Promise<PdfDocumentHandle>;
}

export interface PdfEngine {
  /** Starts loading one document; cancelling means destroying the returned task. */
  openDocument(url: string): Promise<PdfLoadingTask>;
}

type Pdfjs = typeof import("pdfjs-dist");

type PdfLinks = Pick<
  PDFLinkService,
  | "addLinkAttributes"
  | "executeNamedAction"
  | "executeSetOCGState"
  | "getAnchorUrl"
  | "getAttachmentContent"
  | "getDestinationHash"
  | "goToDestination"
>;

async function resolveDestinationPage(
  pdf: PDFDocumentProxy,
  destination: Parameters<PdfLinks["goToDestination"]>[0],
): Promise<number | null> {
  const explicit = Array.isArray(destination) ? destination : await pdf.getDestination(destination);

  const target = explicit?.[0];

  if (target === undefined || target === null) {
    return null;
  }

  // An explicit destination names its page by object reference, or by index in some writers.
  const pageIndex = Number.isInteger(target) ? target : await pdf.getPageIndex(target);

  return pageIndex + 1;
}

/** The link handling pdf.js's annotation layer calls into, without pdf.js's full viewer. */
function createPdfLinks(pdf: PDFDocumentProxy, onPageLink: (pageNumber: number) => void): PdfLinks {
  return {
    addLinkAttributes(link, url) {
      // The worker only passes http(s), ftp, mailto, and tel URLs through.
      link.href = url;
      link.title = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer nofollow";
    },
    // Named actions (next page, print, …) and layer toggles need a full viewer; links using
    // them stay inert rather than half-working.
    executeNamedAction() {},
    async executeSetOCGState() {},
    getAnchorUrl: (anchor) => `#${anchor}`,
    // No download manager is wired, so attachment links have nothing to open.
    getAttachmentContent: async () => null,
    getDestinationHash: () => "#",
    async goToDestination(destination) {
      try {
        const pageNumber = await resolveDestinationPage(pdf, destination);

        if (pageNumber && pageNumber <= pdf.numPages) {
          onPageLink(pageNumber);
        }
      } catch {
        // A destination pointing at a missing object leaves the reader where they are.
      }
    },
  };
}

function wrapPage(pdfjs: Pdfjs, pdf: PDFDocumentProxy, page: PDFPageProxy): PdfPage {
  return {
    cleanup: () => page.cleanup(),
    getViewport: (options) => page.getViewport(options),
    render: ({ scale, ...options }) =>
      page.render({ ...options, viewport: page.getViewport({ scale }) }),
    async renderLinks(scale, onPageLink) {
      const annotations = await page.getAnnotations({ intent: "display" });

      const links = annotations.filter(
        (annotation) => annotation.annotationType === pdfjs.AnnotationType.LINK,
      );

      if (links.length === 0) {
        return null;
      }

      const viewport = page.getViewport({ scale });
      const div = document.createElement("div");
      div.className = "pdf-link-layer";
      // pdf.js sizes the layer from the page's unscaled box times this factor.
      div.style.setProperty("--total-scale-factor", String(viewport.scale * viewport.userUnit));
      // SAFETY: the annotation layer only calls the PdfLinks members on its link service.
      const linkService = createPdfLinks(pdf, onPageLink) as PDFLinkService;

      const layer = new pdfjs.AnnotationLayer({
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        annotationStorage: null,
        commentManager: null,
        div,
        linkService,
        page,
        structTreeLayer: null,
        viewport,
      });

      await layer.render({
        annotations: links,
        div,
        linkService,
        page,
        renderForms: false,
        viewport,
      });

      return div;
    },
  };
}

export const pdfjsEngine: PdfEngine = {
  async openDocument(url) {
    const [pdfjs, workerModule] = await Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]);

    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
    const loadingTask = pdfjs.getDocument({ url });

    return {
      destroy: () => void loadingTask.destroy(),
      promise: loadingTask.promise.then((pdf) => ({
        getPage: async (pageNumber) => wrapPage(pdfjs, pdf, await pdf.getPage(pageNumber)),
        numPages: pdf.numPages,
      })),
    };
  },
};
