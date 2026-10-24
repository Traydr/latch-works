import type { FileQuery, FileRow } from "@latch-works/glazier-core/contract";
import { useCallback, useRef, useState } from "react";

import { call } from "../../lib/api";
import { useEngine } from "../../lib/engine-state";

export type FileListQuery = Omit<FileQuery, "offset" | "limit">;

const PAGE_SIZE = 200;

const EMPTY_PAGES = new Map<number, FileRow[]>();

/** Every file matching a query, paged in from the engine as the list or grid asks for it. */
export interface FilePages {
  /** How many files match; null until the first page arrives. */
  total: number | null;
  totalBytes: number;
  rowAt: (index: number) => FileRow | null;
  /** Loads the pages holding rows `first` to `last` (exclusive) that are not loaded yet. */
  request: (first: number, last: number) => void;
}

interface Loaded {
  key: string;
  pages: Map<number, FileRow[]>;
  total: number | null;
  totalBytes: number;
}

/**
 * Pages of a file query. A new query starts over; a changed catalog refetches pages as they are
 * asked for again, keeping the old rows on screen until the new ones arrive.
 */
export function useFilePages(query: FileListQuery): FilePages {
  const { report, catalogVersion } = useEngine();
  const key = JSON.stringify(query);
  const latestKey = useRef(key);
  const latestQuery = useRef(query);
  const requested = useRef(new Set<string>());

  const [loaded, setLoaded] = useState<Loaded>(() => ({
    key,
    pages: new Map(),
    total: null,
    totalBytes: 0,
  }));

  latestKey.current = key;
  latestQuery.current = query;

  // A new query drops the old rows at once rather than after its first page arrives.
  if (loaded.key !== key) {
    setLoaded({ key, pages: new Map(), total: null, totalBytes: 0 });
  }

  const request = useCallback(
    (first: number, last: number) => {
      const lastPage = Math.floor(Math.max(first, last - 1) / PAGE_SIZE);

      for (let page = Math.floor(first / PAGE_SIZE); page <= lastPage; page += 1) {
        const marker = `${key}|${catalogVersion}|${page}`;

        if (requested.current.has(marker)) {
          continue;
        }

        requested.current.add(marker);

        call("listFiles", {
          ...latestQuery.current,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        }).then(
          (result) => {
            if (latestKey.current !== key) {
              return;
            }

            setLoaded((previous) => ({
              key,
              pages: new Map(previous.key === key ? previous.pages : []).set(page, result.rows),
              total: result.total,
              totalBytes: result.totalBytes,
            }));
          },
          (error: Error) => {
            requested.current.delete(marker);
            report(error);
          },
        );
      }
    },
    [key, catalogVersion, report],
  );

  const pages = loaded.key === key ? loaded.pages : EMPTY_PAGES;

  const rowAt = useCallback(
    (index: number) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE] ?? null,
    [pages],
  );

  return loaded.key === key
    ? { total: loaded.total, totalBytes: loaded.totalBytes, rowAt, request }
    : { total: null, totalBytes: 0, rowAt, request };
}
