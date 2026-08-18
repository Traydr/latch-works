import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

const GRID_GAP_PX = 10;
const GRID_OVERSCAN_ROWS = 4;
const MAIN_HORIZONTAL_PADDING_PX = 24;

/** An inclusive range of grid rows. */
interface RowWindow {
  start: number;
  end: number;
}

/** One virtualized cell: its item index and its position inside the scroll container. */
interface WindowedGridItem {
  index: number;
  left: number;
  top: number;
}

function areRowWindowsEqual(left: RowWindow, right: RowWindow): boolean {
  return left.start === right.start && left.end === right.end;
}

function getVisibleRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowStride: number,
  overscanRows: number,
): RowWindow {
  if (rowCount === 0 || rowStride <= 0) {
    return { start: 0, end: 0 };
  }

  return {
    start: Math.max(0, Math.floor(scrollTop / rowStride) - overscanRows),
    end: Math.min(rowCount - 1, Math.ceil((scrollTop + viewportHeight) / rowStride) + overscanRows),
  };
}

interface UseVirtualGridMetricsResult {
  cardHeight: number;
  cardWidth: number;
  columnCount: number;
  gridWidth: number;
  mainRef: RefObject<HTMLElement | null>;
  overscanWindow: { start: number; end: number };
  rowStride: number;
  totalGridHeight: number;
  viewportWindow: { start: number; end: number };
  windowedItems: Array<{ index: number; left: number; top: number }>;
}

export function useVirtualGridMetrics(
  itemCount: number,
  thumbnailSize: number,
  aspectRatio: 'wide' | 'tall' = 'wide',
): UseVirtualGridMetricsResult {
  const [mainClientWidth, setMainClientWidth] = useState(0);
  const [rowWindows, setRowWindows] = useState({
    overscan: { start: 0, end: 0 },
    viewport: { start: 0, end: 0 },
  });
  const mainRef = useRef<HTMLElement | null>(null);

  const columnWidth = thumbnailSize + 20;
  const effectiveViewportWidth = mainClientWidth > 0 ? mainClientWidth : window.innerWidth;
  const columnCount = useMemo(() => {
    return Math.min(6, Math.max(2, Math.floor((effectiveViewportWidth - 40) / columnWidth)));
  }, [columnWidth, effectiveViewportWidth]);

  const gridWidth = useMemo(() => {
    return Math.max(240, effectiveViewportWidth - MAIN_HORIZONTAL_PADDING_PX);
  }, [effectiveViewportWidth]);

  const cardWidth = useMemo(() => {
    const gapsWidth = GRID_GAP_PX * (columnCount - 1);
    return Math.max(120, Math.floor((gridWidth - gapsWidth) / columnCount));
  }, [columnCount, gridWidth]);

  const cardHeight = useMemo(() => {
    if (aspectRatio === 'tall') {
      return Math.max(180, Math.floor((cardWidth * 16) / 9));
    }

    return Math.max(110, Math.floor((cardWidth * 9) / 16));
  }, [aspectRatio, cardWidth]);

  const rowStride = cardHeight + GRID_GAP_PX;

  const rowCount = useMemo(() => {
    return Math.ceil(itemCount / columnCount);
  }, [columnCount, itemCount]);

  const totalGridHeight = useMemo(() => {
    if (rowCount === 0) {
      return 0;
    }

    return rowCount * cardHeight + Math.max(0, rowCount - 1) * GRID_GAP_PX;
  }, [cardHeight, rowCount]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element) {
      return undefined;
    }

    const syncViewportMetrics = (): void => {
      const nextWidth = element.clientWidth;
      const nextHeight = element.clientHeight;

      setMainClientWidth((current) => (current === nextWidth ? current : nextWidth));
      setRowWindows((current) => {
        const nextViewport = getVisibleRowWindow(
          element.scrollTop,
          nextHeight,
          rowCount,
          rowStride,
          0,
        );
        const nextOverscan = getVisibleRowWindow(
          element.scrollTop,
          nextHeight,
          rowCount,
          rowStride,
          GRID_OVERSCAN_ROWS,
        );

        if (
          areRowWindowsEqual(current.viewport, nextViewport) &&
          areRowWindowsEqual(current.overscan, nextOverscan)
        ) {
          return current;
        }

        return {
          overscan: nextOverscan,
          viewport: nextViewport,
        };
      });
    };

    let frameId: number | null = null;

    const onScroll = (): void => {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        setRowWindows((current) => {
          const nextViewport = getVisibleRowWindow(
            element.scrollTop,
            element.clientHeight,
            rowCount,
            rowStride,
            0,
          );
          const nextOverscan = getVisibleRowWindow(
            element.scrollTop,
            element.clientHeight,
            rowCount,
            rowStride,
            GRID_OVERSCAN_ROWS,
          );

          if (
            areRowWindowsEqual(current.viewport, nextViewport) &&
            areRowWindowsEqual(current.overscan, nextOverscan)
          ) {
            return current;
          }

          return {
            overscan: nextOverscan,
            viewport: nextViewport,
          };
        });
      });
    };

    syncViewportMetrics();

    const resizeObserver = new window.ResizeObserver(() => {
      syncViewportMetrics();
    });

    resizeObserver.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      resizeObserver.disconnect();
      element.removeEventListener('scroll', onScroll);
    };
  }, [rowCount, rowStride]);

  const windowedItems = useMemo(() => {
    if (itemCount === 0) {
      return [];
    }

    const startIndex = rowWindows.overscan.start * columnCount;
    const endIndex = Math.min(itemCount, (rowWindows.overscan.end + 1) * columnCount);
    const nextItems: WindowedGridItem[] = [];

    for (let index = startIndex; index < endIndex; index += 1) {
      const row = Math.floor(index / columnCount);
      const column = index % columnCount;
      nextItems.push({
        index,
        top: row * rowStride,
        left: column * (cardWidth + GRID_GAP_PX),
      });
    }

    return nextItems;
  }, [
    cardWidth,
    columnCount,
    itemCount,
    rowStride,
    rowWindows.overscan.end,
    rowWindows.overscan.start,
  ]);

  return {
    cardHeight,
    cardWidth,
    columnCount,
    gridWidth,
    mainRef,
    overscanWindow: rowWindows.overscan,
    rowStride,
    totalGridHeight,
    viewportWindow: rowWindows.viewport,
    windowedItems,
  };
}
