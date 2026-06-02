import { useCallback, useEffect, useRef } from 'react';

import type { MediaItem, VideoProbeMetadata } from '../../shared/types';
import { frameViewClient } from '../services/frameViewClient';

interface UseVideoMetadataQueueOptions {
  activeScanRunId: number | null;
  applyVideoMetadata: (
    path: string,
    mtimeMs: number,
    size: number,
    metadata: VideoProbeMetadata,
  ) => void;
}

export function useVideoMetadataQueue({
  activeScanRunId,
  applyVideoMetadata,
}: UseVideoMetadataQueueOptions): (item: MediaItem) => void {
  const metadataProbeQueueRef = useRef<MediaItem[]>([]);
  const metadataProbeInFlightRef = useRef(0);
  const metadataProbeQueuedIdsRef = useRef(new Set<string>());
  const metadataProbeCompletedIdsRef = useRef(new Set<string>());

  const pumpVideoMetadataQueue = useCallback((): void => {
    const MAX_PROBE_CONCURRENCY = 2;

    while (
      metadataProbeInFlightRef.current < MAX_PROBE_CONCURRENCY &&
      metadataProbeQueueRef.current.length > 0
    ) {
      const item = metadataProbeQueueRef.current.shift();
      if (!item) {
        continue;
      }

      metadataProbeInFlightRef.current += 1;

      void (async () => {
        try {
          const metadata = await frameViewClient.probeVideoMetadata({
            path: item.path,
            mtimeMs: item.mtimeMs,
            size: item.size,
          });

          if (!metadata) {
            return;
          }

          applyVideoMetadata(item.path, item.mtimeMs, item.size, metadata);
        } catch {
          // Ignore probe failures for best-effort metadata enrichment.
        } finally {
          metadataProbeInFlightRef.current -= 1;
          metadataProbeQueuedIdsRef.current.delete(item.id);
          metadataProbeCompletedIdsRef.current.add(item.id);

          if (metadataProbeQueueRef.current.length > 0) {
            pumpVideoMetadataQueue();
          }
        }
      })();
    }
  }, [applyVideoMetadata]);

  useEffect(() => {
    metadataProbeQueueRef.current = [];
    metadataProbeQueuedIdsRef.current.clear();
    metadataProbeCompletedIdsRef.current.clear();
  }, [activeScanRunId]);

  return useCallback(
    (item: MediaItem): void => {
      if (
        item.mediaType !== 'video' ||
        item.durationMs !== undefined ||
        item.width !== undefined ||
        item.height !== undefined ||
        item.codec !== undefined
      ) {
        return;
      }

      if (
        metadataProbeCompletedIdsRef.current.has(item.id) ||
        metadataProbeQueuedIdsRef.current.has(item.id)
      ) {
        return;
      }

      metadataProbeQueuedIdsRef.current.add(item.id);
      metadataProbeQueueRef.current.push(item);
      pumpVideoMetadataQueue();
    },
    [pumpVideoMetadataQueue],
  );
}
