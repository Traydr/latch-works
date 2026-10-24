import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** A scrolling element's size and scroll position, for virtualizing what it shows. */
export function useScrollBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useLayoutEffect(() => {
    const element = ref.current;

    if (!element) {
      return;
    }

    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);

    observer.observe(element);
    measure();

    return () => observer.disconnect();
  }, []);

  /** Scrolls the least distance that shows `top` to `bottom`, leaving `inset` uncovered below. */
  const show = useCallback((top: number, bottom: number, headerHeight = 0, inset = 0) => {
    const element = ref.current;

    if (!element) {
      return;
    }

    if (top - headerHeight < element.scrollTop) {
      element.scrollTop = top - headerHeight;
    } else if (bottom > element.scrollTop + element.clientHeight - inset) {
      element.scrollTop = bottom - element.clientHeight + inset;
    }
  }, []);

  return {
    ref,
    scrollTop,
    width: size.width,
    height: size.height,
    onScroll: (event: { currentTarget: HTMLDivElement }) =>
      setScrollTop(event.currentTarget.scrollTop),
    show,
  };
}
