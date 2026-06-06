import { useCallback, useEffect, useRef, useState } from "react";

const MAX_RETRIES = 12;

export function useThumbnailUrl(url: string | undefined) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(url);
  const [loading, setLoading] = useState(Boolean(url));
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef(0);

  const load = useCallback(async (targetUrl: string, signal: AbortSignal) => {
    setLoading(true);
    setFailed(false);

    const response = await fetch(targetUrl, {
      credentials: "include",
      redirect: "follow",
      signal,
    });

    if (signal.aborted) {
      return;
    }

    if (response.status === 503) {
      const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
      if (retryRef.current < MAX_RETRIES) {
        retryRef.current += 1;
        await new Promise((resolve) => {
          window.setTimeout(resolve, Math.max(250, retryAfter * 1000));
        });
        if (!signal.aborted) {
          await load(targetUrl, signal);
        }
      } else {
        setLoading(false);
        setFailed(true);
      }
      return;
    }

    if (!response.ok) {
      setLoading(false);
      setFailed(true);
      return;
    }

    const blob = await response.blob();
    if (signal.aborted) {
      return;
    }

    setResolvedUrl(URL.createObjectURL(blob));
    setLoading(false);
    setFailed(false);
    retryRef.current = 0;
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    retryRef.current = 0;

    if (!url) {
      setResolvedUrl(undefined);
      setLoading(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    void load(url, controller.signal);

    return () => {
      controller.abort();
    };
  }, [load, url]);

  useEffect(() => {
    return () => {
      if (resolvedUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(resolvedUrl);
      }
    };
  }, [resolvedUrl]);

  return { failed, loading, resolvedUrl };
}
