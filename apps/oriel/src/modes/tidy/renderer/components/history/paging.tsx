import { useCallback, useEffect, useRef, useState } from "react";

import { useEngine } from "../../lib/engine-state";

interface Loaded<Page> {
  key: string;
  generation: string;
  pages: Page[];
}

interface Paged<Page> {
  /** Every page loaded so far, or null until the first arrives. */
  pages: Page[] | null;
  loadMore: () => void;
  refresh: () => void;
}

/**
 * Pages of an engine list, loaded one more at a time as the user scrolls. Every loaded page is
 * fetched again when the catalog changes, and the old pages stay on screen until the new ones
 * arrive. `key` names the query; a new key starts again from the first page.
 */
export function usePages<Page>(
  key: string | null,
  load: (offset: number, limit: number) => Promise<Page>,
  pageSize: number,
): Paged<Page> {
  const { catalogVersion, report } = useEngine();
  const [wanted, setWanted] = useState({ key, count: 1 });
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<Page> | null>(null);
  const latest = useRef(loaded);
  const loadRef = useRef(load);

  latest.current = loaded;
  loadRef.current = load;

  const count = wanted.key === key ? wanted.count : 1;
  const generation = key === null ? null : `${key}|${catalogVersion}|${nonce}`;
  const pages = loaded && loaded.key === key ? loaded.pages : null;
  const loadedCount = pages?.length ?? 0;

  useEffect(() => {
    if (key === null || generation === null) {
      setLoaded(null);

      return;
    }

    const current = latest.current;
    const kept = current?.generation === generation ? current.pages : [];

    if (kept.length >= count) {
      return;
    }

    let live = true;

    const offsets = Array.from(
      { length: count - kept.length },
      (_, index) => (kept.length + index) * pageSize,
    );

    Promise.all(offsets.map((offset) => loadRef.current(offset, pageSize))).then(
      (fresh) => {
        if (live) {
          setLoaded({ key, generation, pages: [...kept, ...fresh] });
        }
      },
      (cause: unknown) => {
        if (live) {
          report(cause);
        }
      },
    );

    return () => {
      live = false;
    };
  }, [key, generation, count, pageSize, report]);

  const loadMore = useCallback(() => {
    // One page at a time: a request already waiting for its page is left alone.
    setWanted((current) =>
      current.key === key && current.count > loadedCount
        ? current
        : { key, count: loadedCount + 1 },
    );
  }, [key, loadedCount]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  return { pages, loadMore, refresh };
}

/**
 * An invisible line at the end of a list that asks for the next page as it nears the screen.
 * Give it a `key` that changes with each page, so a line still in view asks again.
 */
export function LoadMore({ onVisible }: { onVisible: () => void }) {
  const line = useRef<HTMLDivElement>(null);
  const latest = useRef(onVisible);

  latest.current = onVisible;

  useEffect(() => {
    const element = line.current;

    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          latest.current();
        }
      },
      { rootMargin: "800px 0px" },
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return <div ref={line} className="h-px" aria-hidden />;
}
