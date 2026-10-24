import type {
  DuplicateScope,
  DuplicateSetPage,
  RootId,
  SimilarityLevel,
} from "@latch-works/glazier-core/contract";
import { useCallback, useEffect, useRef, useState } from "react";

import { call } from "../../lib/api";
import { useEngine } from "../../lib/engine-state";

const PAGE_SIZE = 100;

interface QueueRequest {
  rootId: RootId;
  level: SimilarityLevel;
  scope: DuplicateScope;
  dismissed: boolean;
}

/**
 * The sets, loaded a page at a time as the queue scrolls. A refresh (any catalog change) reloads
 * as many as were loaded and swaps them in at once, so the list never blanks.
 */
export function useSetQueue(request: QueueRequest) {
  const { catalogVersion, report } = useEngine();
  const key = JSON.stringify(request);

  const [loaded, setLoaded] = useState<{
    key: string;
    version: number;
    data: DuplicateSetPage;
  } | null>(null);

  const [wanted, setWanted] = useState({ key, count: PAGE_SIZE });
  const count = wanted.key === key ? wanted.count : PAGE_SIZE;
  const requestRef = useRef(request);
  const latest = useRef("");

  requestRef.current = request;

  useEffect(() => {
    const stamp = `${key}|${catalogVersion}|${count}`;
    const current = requestRef.current;
    const version = catalogVersion;

    latest.current = stamp;

    const load = async () => {
      let result: DuplicateSetPage | null = null;

      // Fetches in chunks of the method's 500 limit until `count` sets are in hand.
      while (result === null || (result.sets.length < count && result.sets.length < result.total)) {
        const offset: number = result?.sets.length ?? 0;

        const chunk = await call("duplicateSets", {
          rootId: current.rootId,
          level: current.level,
          scope: current.scope,
          dismissed: current.dismissed,
          offset,
          limit: Math.min(500, count - offset),
        });

        result = result === null ? chunk : { ...chunk, sets: [...result.sets, ...chunk.sets] };

        if (chunk.sets.length === 0) {
          break;
        }
      }

      if (latest.current === stamp) {
        setLoaded({ key, version, data: result });
      }
    };

    load().catch(report);
  }, [key, catalogVersion, count, report]);

  const current = loaded?.key === key ? loaded : null;

  const loadMore = useCallback(() => {
    const next = current ? current.data.sets.length + PAGE_SIZE : 0;

    if (current && current.data.sets.length < current.data.total && next > count) {
      setWanted({ key, count: next });
    }
  }, [current, key, count]);

  return { data: current?.data ?? null, version: current?.version ?? -1, loadMore };
}
