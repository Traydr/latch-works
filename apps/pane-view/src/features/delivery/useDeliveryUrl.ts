import { useEffect, useMemo, useReducer, useRef } from "react";
import { type DeliveryCacheRequest, deliveryCache, deliveryCacheKey } from "./delivery-cache";

interface DeliveryUrlState {
  failed: boolean;
  inputKey: string;
  loading: boolean;
  resolvedUrl?: string;
}

type DeliveryUrlAction =
  | { inputKey: string; type: "failed" }
  | { inputKey: string; type: "pending" }
  | { inputKey: string; type: "ready"; url: string }
  | { state: DeliveryUrlState; type: "reset" };

function deliveryUrlReducer(state: DeliveryUrlState, action: DeliveryUrlAction): DeliveryUrlState {
  if (action.type === "reset") {
    return action.state;
  }

  if (action.inputKey !== state.inputKey) {
    return state;
  }

  switch (action.type) {
    case "ready":
      return { ...state, failed: false, loading: false, resolvedUrl: action.url };
    case "failed":
      return { ...state, failed: true, loading: false };
    case "pending":
      return { ...state, failed: false, loading: true, resolvedUrl: undefined };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** `cssWidth` in device pixels, the width a rendition shown that wide on this screen needs. */
export function devicePixelWidth(cssWidth: number): number {
  const ratio = "window" in globalThis ? window.devicePixelRatio || 1 : 1;

  return Math.max(1, Math.round(cssWidth * ratio));
}

/**
 * The delivery URL for one item, resolved through the shared cache. A
 * `readyUrl` the caller already holds (a grid tile's batch answer) is used as
 * is. `refresh` re-resolves past a cached URL the caller's element kept
 * failing on (an expired presigned original or Shutter capability). A failed
 * resolve shows as failed at once but keeps retrying on the cache's backoff
 * while mounted; an unavailable one stops.
 */
export function useDeliveryUrl({
  readyUrl,
  refresh = false,
  request,
}: {
  readyUrl?: string;
  refresh?: boolean;
  request: DeliveryCacheRequest | undefined;
}) {
  const requestKey = request ? deliveryCacheKey(request) : "none";
  const inputKey = `${requestKey}:${refresh}:${readyUrl ?? ""}`;
  const requestRef = useRef(request);
  requestRef.current = request;

  const initialState = useMemo((): DeliveryUrlState => {
    const current = requestRef.current;
    const cachedUrl = current && !refresh ? deliveryCache.peek(current) : undefined;
    const resolvedUrl = readyUrl ?? cachedUrl;

    return { failed: false, inputKey, loading: Boolean(current) && !resolvedUrl, resolvedUrl };
  }, [inputKey, readyUrl, refresh]);

  const [storedState, dispatch] = useReducer(deliveryUrlReducer, initialState);
  const state = storedState.inputKey === inputKey ? storedState : initialState;

  // The reducer key and cancellation check both reject stale async results after an input change.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    dispatch({ state: initialState, type: "reset" });

    const current = requestRef.current;

    if (!current || initialState.resolvedUrl) {
      return;
    }

    let cancelled = false;
    let refreshNext = refresh;

    void (async () => {
      while (!cancelled) {
        const result = await deliveryCache.resolve(current, { refresh: refreshNext });
        refreshNext = false;

        if (cancelled) return;

        if (result.status === "ready") {
          dispatch({ inputKey, type: "ready", url: result.url });

          return;
        }

        if (result.status === "unavailable") {
          dispatch({ inputKey, type: "failed" });

          return;
        }

        dispatch({ inputKey, type: result.status === "failed" ? "failed" : "pending" });

        await delay(result.retryAfterMs);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialState, inputKey, refresh]);

  return {
    failed: state.failed,
    loading: state.loading,
    resolvedUrl: state.resolvedUrl,
  };
}
