import { type JSX, useEffect, useRef, useState } from "react";

interface PdfViewerProps {
  mediaId: string;
  title: string;
}

export function PdfViewer({ mediaId, title }: PdfViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let cancelled = false;
    container.replaceChildren();

    const render = async () => {
      try {
        const [pdfjs, workerModule] = await Promise.all([
          import("pdfjs-dist"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);

        if (cancelled) {
          return;
        }

        pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;

        const loadingTask = pdfjs.getDocument({ url: `/api/media/${mediaId}/original` });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          return;
        }

        setPageCount(pdf.numPages);

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (cancelled) {
            return;
          }

          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.2 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mx-auto w-full max-w-4xl rounded bg-white";

          const context = canvas.getContext("2d");
          if (!context) {
            continue;
          }

          await page.render({ canvas, canvasContext: context, viewport }).promise;
          container.append(canvas);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to load PDF");
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return (
    <div className="h-full w-full overflow-auto px-3 py-2">
      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {pageCount > 0 ? (
        <p className="mb-3 text-center text-xs text-zinc-400">
          {title} · {pageCount} pages
        </p>
      ) : null}
      <div ref={containerRef} className="flex flex-col gap-4" />
    </div>
  );
}
