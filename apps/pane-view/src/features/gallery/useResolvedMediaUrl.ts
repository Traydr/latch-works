import { useEffect, useState } from "react";
import { resolveMediaDeliveryUrl } from "@/features/media/media-delivery-service";

const MAX_RETRIES = 12;

export function useResolvedMediaUrl({
  mediaId,
  refreshKey = 0,
  size,
  variant,
}: {
  mediaId: string | undefined;
  refreshKey?: number;
  size?: number;
  variant: "thumbnail" | "preview" | "original";
}) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>();
  const [loading, setLoading] = useState(Boolean(mediaId));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mediaId) {
      setResolvedUrl(undefined);
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
        try {
          const result = await resolveMediaDeliveryUrl({
            data: { mediaId, size, variant },
          });

          if (cancelled) {
            return;
          }

          setResolvedUrl(result.url);
          setLoading(false);
          setFailed(false);
          return;
        } catch (error) {
          if (cancelled) {
            return;
          }

          if (error instanceof Error && error.message === "Derivative pending") {
            await new Promise((resolve) => {
              window.setTimeout(resolve, 1000);
            });
            continue;
          }

          setFailed(true);
          setLoading(false);
          return;
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
  }, [mediaId, refreshKey, size, variant]);

  return { failed, loading, resolvedUrl };
}
