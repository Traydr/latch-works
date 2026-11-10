import { UnauthorizedErrorSchema } from "@/features/auth/unauthorized";
import { createConcurrencyLimiter } from "@/lib/concurrency-limiter";
import {
  DELIVERY_URL_LIFETIME_SECONDS,
  type DeliveryOutcome,
  type DeliveryRequest,
  type DeliveryResult,
  deliveryKey,
  MAX_DELIVERY_BATCH,
} from "./delivery-contract";
import { resolveMediaDeliveryUrls } from "./delivery-service";

/**
 * The browser's one cache of delivery URLs. Grid windows resolve in batches
 * and the viewer one item at a time, but both read and write the same
 * entries, so a tile URL the grid resolved answers the viewer too. One retry
 * policy covers both: a pending preview waits as Shutter asks (at least the
 * backoff below), a failure retries on a slower backoff, an unavailable item
 * is never asked for again, and a ready URL is kept until shortly before it
 * expires. Once the session has gone nothing more is asked for.
 */

/**
 * One item as the cache keys it. `revision` is the item's content hash: a
 * synced replacement keeps the media id but not the bytes, so a URL cached
 * for one revision never answers for another. Cache key only; never sent.
 */
export type DeliveryCacheRequest = DeliveryRequest & { revision: string };

/** An answer that stands: a URL, or word that no rendition exists. */
export type SettledDelivery = { status: "ready"; url: string } | { status: "unavailable" };

/** What a cache lookup reports: a settled answer, or how long until the next attempt is due. */
type CachedDelivery = SettledDelivery | { retryAfterMs: number; status: "failed" | "pending" };

interface CacheEntry {
  /** Consecutive answers that were not a URL, for the backoff. */
  attempts: number;
  /** Settles when the request fetching this entry completes; absent otherwise. */
  inFlight?: Promise<void>;
  nextAttemptAt: number;
  state:
    | { expiresAt: number; status: "ready"; url: string }
    | { status: "failed" | "pending" | "unavailable" };
}

const PENDING_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const;

/**
 * A failure retries rather than settling for good: the server reports a
 * transient Control fault and a broken preview job alike as failed, and
 * either may be repaired while the item is still on screen. The steps are
 * slow so a broken Shutter is not hammered by every tile on screen.
 */
const FAILED_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

/** A URL is dropped this long before it expires, so none is handed out about to lapse. */
const EXPIRY_MARGIN_MS = 60 * 60 * 1000;

/**
 * Most settled entries kept, oldest use evicted first. A grid window is at
 * most about a hundred items, so this spans many windows of scrolling back.
 * Entries in flight are never evicted: dropping one would re-request it
 * before its request settles.
 */
const CACHE_LIMIT = 1_000;

/** Single-item resolves running at once, so a burst of viewer requests queues instead of storming. */
const singleResolveLimiter = createConcurrencyLimiter(6);

/** The request as the server answers it: no revision. */
function serverRequest(request: DeliveryCacheRequest): DeliveryRequest {
  return request.variant === "original"
    ? { mediaId: request.mediaId, variant: request.variant }
    : { mediaId: request.mediaId, variant: request.variant, width: request.width };
}

export function deliveryCacheKey(request: DeliveryCacheRequest): string {
  return `${deliveryKey(request)}:${request.revision}`;
}

function retryDelayMs(attempt: number, delays: readonly number[], serverRetryAfterMs = 0): number {
  const base = delays[Math.min(attempt, delays.length - 1)] ?? 60_000;
  const jitter = 0.75 + Math.random() * 0.5;

  return Math.max(serverRetryAfterMs, Math.round(base * jitter));
}

function createDeliveryCache(
  resolveUrls: typeof resolveMediaDeliveryUrls,
  { onSignedOut }: { onSignedOut: () => void },
) {
  const entries = new Map<string, CacheEntry>();
  const retryListeners = new Set<() => void>();
  let inFlightCount = 0;
  let signedOut = false;

  function readEntry(key: string, now = Date.now()): CacheEntry | undefined {
    const entry = entries.get(key);

    if (entry?.state.status === "ready" && entry.state.expiresAt <= now && !entry.inFlight) {
      entries.delete(key);

      return undefined;
    }

    return entry;
  }

  /** Stores an entry as the most recently used, then evicts the least recently used past the limit. */
  function writeEntry(key: string, entry: CacheEntry): void {
    const previous = entries.get(key);

    inFlightCount += (entry.inFlight ? 1 : 0) - (previous?.inFlight ? 1 : 0);
    entries.delete(key);
    entries.set(key, entry);

    for (const [candidateKey, candidate] of entries) {
      if (entries.size - inFlightCount <= CACHE_LIMIT) break;

      if (!candidate.inFlight) entries.delete(candidateKey);
    }
  }

  function settle(key: string, outcome: DeliveryOutcome): void {
    const now = Date.now();
    const attempts = entries.get(key)?.attempts ?? 0;

    switch (outcome.status) {
      case "ready":
        writeEntry(key, {
          attempts: 0,
          nextAttemptAt: 0,
          state: {
            expiresAt: now + DELIVERY_URL_LIFETIME_SECONDS * 1000 - EXPIRY_MARGIN_MS,
            status: "ready",
            url: outcome.url,
          },
        });

        return;
      case "unavailable":
        writeEntry(key, { attempts: 0, nextAttemptAt: 0, state: { status: "unavailable" } });

        return;
      case "pending":
      case "failed": {
        const delayMs =
          outcome.status === "pending"
            ? retryDelayMs(attempts, PENDING_RETRY_DELAYS_MS, outcome.retryAfterMs)
            : retryDelayMs(attempts, FAILED_RETRY_DELAYS_MS);

        writeEntry(key, {
          attempts: attempts + 1,
          nextAttemptAt: now + delayMs,
          state: { status: outcome.status },
        });
      }
    }
  }

  function lookup(key: string, now = Date.now()): CachedDelivery | null {
    const entry = readEntry(key, now);

    if (!entry || entry.inFlight) return null;

    if (entry.state.status === "ready") return { status: "ready", url: entry.state.url };

    if (entry.state.status === "unavailable") return { status: "unavailable" };

    return entry.nextAttemptAt > now
      ? { retryAfterMs: entry.nextAttemptAt - now, status: entry.state.status }
      : null;
  }

  /** Whether `entry` waits on nothing: a settled answer, or a request already out. */
  function needsNoAttempt(entry: CacheEntry | undefined): boolean {
    return (
      entry?.state.status === "ready" || entry?.state.status === "unavailable" || !!entry?.inFlight
    );
  }

  /** Fetch `batch` (keyed) in one call, marking each entry in flight until it settles. */
  function fetchBatch(batch: ReadonlyMap<string, DeliveryCacheRequest>): Promise<void> {
    const keyByServerKey = new Map([...batch].map(([key, request]) => [deliveryKey(request), key]));

    const execution = (async () => {
      let results: DeliveryResult[] = [];
      let failed = false;

      try {
        ({ results } = await resolveUrls({
          data: { items: [...batch.values()].map(serverRequest) },
        }));
      } catch (error) {
        failed = true;

        if (UnauthorizedErrorSchema.safeParse(error).success) {
          if (!signedOut) onSignedOut();
          signedOut = true;
        } else {
          console.warn("[pane-view] Unable to resolve delivery URLs", error);
        }
      }

      const settled = new Set<string>();

      for (const result of results) {
        const key = keyByServerKey.get(deliveryKey(result));

        if (key) {
          settled.add(key);
          settle(key, result);
        }
      }

      for (const key of batch.keys()) {
        if (!settled.has(key)) {
          settle(key, failed ? { status: "failed" } : { retryAfterMs: 0, status: "pending" });
        }
      }
    })();

    for (const key of batch.keys()) {
      const previous = entries.get(key);

      writeEntry(key, {
        attempts: previous?.attempts ?? 0,
        inFlight: execution,
        nextAttemptAt: 0,
        state: previous?.state ?? { status: "pending" },
      });
    }

    return execution;
  }

  return {
    /** The cached URL for `request`, if one is ready. */
    peek(request: DeliveryCacheRequest): string | undefined {
      const cached = lookup(deliveryCacheKey(request));

      return cached?.status === "ready" ? cached.url : undefined;
    },

    /**
     * One item: the cached answer while it holds, otherwise a fresh resolve
     * (an in-flight one is joined). `refresh` discards a cached URL first, for
     * a caller whose element kept failing on it.
     */
    async resolve(
      request: DeliveryCacheRequest,
      { refresh = false }: { refresh?: boolean } = {},
    ): Promise<CachedDelivery> {
      const key = deliveryCacheKey(request);

      for (;;) {
        const entry = readEntry(key);

        if (entry?.inFlight) {
          await entry.inFlight;

          continue;
        }

        if (refresh && entry) {
          entries.delete(key);
          refresh = false;
        }

        const cached = lookup(key);

        if (cached) return cached;

        if (signedOut) return { status: "unavailable" };

        await singleResolveLimiter.run(() => fetchBatch(new Map([[key, request]])));

        return lookup(key) ?? { retryAfterMs: 0, status: "pending" };
      }
    },

    /**
     * A grid window: waits for requests already fetching any of these items
     * (so every caller sees the settled state), then fetches the ones due in
     * one batch. Never rejects.
     */
    async resolveWindow(requests: readonly DeliveryCacheRequest[]): Promise<void> {
      for (;;) {
        const inFlight = new Set(
          requests.flatMap((request) => entries.get(deliveryCacheKey(request))?.inFlight ?? []),
        );

        if (inFlight.size === 0) break;
        await Promise.all(inFlight);
      }

      if (signedOut) return;

      const now = Date.now();
      const due = new Map<string, DeliveryCacheRequest>();

      for (const request of requests) {
        const key = deliveryCacheKey(request);
        const entry = readEntry(key, now);

        // Still on screen, so keep it clear of eviction whatever its state.
        if (entry) writeEntry(key, entry);

        if (!lookup(key, now) && due.size < MAX_DELIVERY_BATCH) due.set(key, request);
      }

      if (due.size > 0) await fetchBatch(due);
    },

    /** Settled answers among `requests`, by media id. */
    settled(requests: readonly DeliveryCacheRequest[]): ReadonlyMap<string, SettledDelivery> {
      const answers = new Map<string, SettledDelivery>();

      for (const request of requests) {
        const cached = lookup(deliveryCacheKey(request));

        if (cached?.status === "ready" || cached?.status === "unavailable") {
          answers.set(request.mediaId, cached);
        }
      }

      return answers;
    },

    /**
     * Milliseconds until the first of `requests` is due again: 0 when one is
     * due now, null when none will be (all settled, or the session has gone).
     */
    nextAttemptInMs(requests: readonly DeliveryCacheRequest[]): number | null {
      if (signedOut) return null;

      const now = Date.now();
      let earliest: number | null = null;

      for (const request of requests) {
        const entry = readEntry(deliveryCacheKey(request), now);

        if (needsNoAttempt(entry)) continue;

        const wait = Math.max(0, (entry?.nextAttemptAt ?? 0) - now);

        earliest = earliest === null ? wait : Math.min(earliest, wait);
      }

      return earliest;
    },

    /** Make every failed entry due now, for a user-requested refresh, and tell window resolvers. */
    retryFailed(): void {
      for (const entry of entries.values()) {
        if (entry.state.status === "failed" && !entry.inFlight) {
          entry.attempts = 0;
          entry.nextAttemptAt = 0;
        }
      }

      for (const listener of retryListeners) listener();
    },

    subscribeToRetries(listener: () => void): () => void {
      retryListeners.add(listener);

      return () => retryListeners.delete(listener);
    },
  };
}

export const deliveryCache = createDeliveryCache(resolveMediaDeliveryUrls, {
  onSignedOut: () => window.location.assign("/login"),
});
