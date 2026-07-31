const MAX_PAGE_WIDTH_PX = 896;
const MAX_RETAINED_CANVASES = 8;
const PAGE_OVERSCAN = 2;

export function getPageRenderWidth(container: HTMLElement): number {
  const width = container.clientWidth;
  if (width > 0) {
    return Math.min(width, MAX_PAGE_WIDTH_PX);
  }

  const parentWidth = container.parentElement?.clientWidth ?? window.innerWidth;
  return Math.min(Math.max(parentWidth - 24, 320), MAX_PAGE_WIDTH_PX);
}

export function getPdfPageRenderWindow(
  visiblePages: Iterable<number>,
  pageCount: number,
  focalPage = 1,
): number[] {
  const focal = Math.min(Math.max(focalPage, 1), pageCount);
  const visible = [...new Set(visiblePages)].filter((page) => page >= 1 && page <= pageCount);
  const selected = new Set(
    visible.length <= MAX_RETAINED_CANVASES
      ? visible
      : visible
          .sort((left, right) => Math.abs(left - focal) - Math.abs(right - focal) || left - right)
          .slice(0, MAX_RETAINED_CANVASES),
  );

  if (selected.size === 0) {
    selected.add(focal);
  }

  for (
    let distance = 1;
    distance <= PAGE_OVERSCAN && selected.size < MAX_RETAINED_CANVASES;
    distance += 1
  ) {
    const candidates = [focal - distance, focal + distance];
    let added = false;
    for (const page of candidates) {
      if (page >= 1 && page <= pageCount && !selected.has(page)) {
        selected.add(page);
        added = true;
        if (selected.size === MAX_RETAINED_CANVASES) {
          break;
        }
      }
    }
    if (!added && focal - distance < 1 && focal + distance > pageCount) {
      break;
    }
  }

  return [...selected].sort((left, right) => left - right);
}

export function resolveVisiblePdfPage(entries: IntersectionObserverEntry[]): number | null {
  let bestPage: number | null = null;
  let bestRatio = 0;

  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const pageValue = entry.target.getAttribute("data-page-number");
    const pageNumber = pageValue ? Number(pageValue) : Number.NaN;
    if (!Number.isFinite(pageNumber) || pageNumber < 1) {
      continue;
    }

    if (entry.intersectionRatio > bestRatio) {
      bestRatio = entry.intersectionRatio;
      bestPage = pageNumber;
    }
  }

  return bestPage;
}

export function scrollToPdfPage(container: HTMLElement, page: number): void {
  const target = container.querySelector<HTMLElement>(`[data-page-number="${page}"]`);
  target?.scrollIntoView({ block: "start" });
}
