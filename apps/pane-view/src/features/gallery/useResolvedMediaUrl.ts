import { useEffect, useState } from "react";
import { resolveMediaDeliveryUrl } from "@/features/media/media-delivery-service";
import {
  acquireResolveSlot,
  backoffDelayMs,
  circuitWaitMs,
  delay,
  isCircuitOpen,
  recordResolveFailure,
  recordResolveSuccess,
} from "./resolve-throttle";

const MAX_THUMBNAIL_RETRIES = 12;
const MAX_PREVIEW_RETRIES = 30;

export function useResolvedMediaUrl({
  fallbackReadyUrl,
  mediaId,
  readyUrl,
  refreshKey = 0,
  size,
  variant,
}: {
  fallbackReadyUrl?: string;
  mediaId: string | undefined;
  readyUrl?: string;
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(readyUrl ?? fallbackReadyUrl);
  const [loading, setLoading] = useState(Boolean(mediaId) && !readyUrl && !fallbackReadyUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mediaId) {
      setResolvedUrl(undefined);
      setLoading(false);
      setFailed(false);
      return;
    }

    // Snapshot already provided a ready delivery URL: render directly and skip
    // the server-function round-trip entirely. This is the common case and the
    // primary fix for the gallery request storm.
    if (readyUrl) {
      setResolvedUrl(readyUrl);
      setLoading(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setLoading(!fallbackReadyUrl);
    setFailed(false);
    setResolvedUrl(fallbackReadyUrl);

    const maxRetries = variant === "preview" ? MAX_PREVIEW_RETRIES : MAX_THUMBNAIL_RETRIES;

    void (async () => {
      for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        if (cancelled) {
          return;
        }

        // Back off globally while the breaker is open so we stop hammering a
        // server that is already failing or cold-booting.
        const breakerWait = circuitWaitMs();
        if (isCircuitOpen() && breakerWait > 0) {
          await delay(breakerWait);
          if (cancelled) {
            return;
          }
        }

        const release = await acquireResolveSlot();
        let pending = false;

        try {
          if (cancelled) {
            return;
          }

          const result = await resolveMediaDeliveryUrl({
            data: { mediaId, size, variant },
          });

          if (cancelled) {
            return;
          }

          if (result.pending) {
            pending = true;
            if (fallbackReadyUrl) {
              setResolvedUrl(fallbackReadyUrl);
              setLoading(false);
            }
          } else {
            recordResolveSuccess();
            setResolvedUrl(result.url);
            setLoading(false);
            setFailed(false);
            return;
          }
        } catch {
          if (cancelled) {
            return;
          }

          recordResolveFailure();
          setFailed(true);
          setLoading(false);
          return;
        } finally {
          release();
        }

        if (pending) {
          await delay(backoffDelayMs(attempt));
        }
      }

      if (!cancelled) {
        if (fallbackReadyUrl) {
          setResolvedUrl(fallbackReadyUrl);
          setLoading(false);
          setFailed(false);
        } else {
          setFailed(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fallbackReadyUrl, mediaId, readyUrl, refreshKey, size, variant]);

  return { failed, loading, resolvedUrl };
}
