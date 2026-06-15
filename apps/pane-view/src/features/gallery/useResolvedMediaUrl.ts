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

const MAX_RETRIES = 12;

export function useResolvedMediaUrl({
  mediaId,
  readyUrl,
  refreshKey = 0,
  size,
  variant,
}: {
  mediaId: string | undefined;
  readyUrl?: string;
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(readyUrl);
  const [loading, setLoading] = useState(Boolean(mediaId) && !readyUrl);
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
    setLoading(true);
    setFailed(false);
    setResolvedUrl(undefined);

    void (async () => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
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

          recordResolveSuccess();
          setResolvedUrl(result.url);
          setLoading(false);
          setFailed(false);
          return;
        } catch (error) {
          if (cancelled) {
            return;
          }

          if (error instanceof Error && error.message === "Derivative pending") {
            pending = true;
          } else {
            recordResolveFailure();
            setFailed(true);
            setLoading(false);
            return;
          }
        } finally {
          release();
        }

        if (pending) {
          await delay(backoffDelayMs(attempt));
        }
      }

      if (!cancelled) {
        setFailed(true);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaId, readyUrl, refreshKey, size, variant]);

  return { failed, loading, resolvedUrl };
}
