/** One pushed item's bytes and the time it took, from its start to its success. */
export interface TransferSpan {
  from: number;
  to: number;
  bytes: number;
}

/** How far back the current throughput and the ETA look. */
const RATE_WINDOW_MS = 10_000;

/** Spans kept per run; older neighbours are merged so a long push stays cheap to chart. */
const MAX_SPANS = 1500;

/** The part of `span`'s bytes transferred between `from` and `to`, assuming a steady rate. */
function bytesWithin(span: TransferSpan, from: number, to: number): number {
  const duration = span.to - span.from;

  if (duration <= 0) {
    return span.from >= from && span.from < to ? span.bytes : 0;
  }

  const overlap = Math.min(span.to, to) - Math.max(span.from, from);

  return overlap > 0 ? (span.bytes * overlap) / duration : 0;
}

/**
 * Bytes per second over the few seconds up to the latest finished item, counting from no earlier
 * than `since` (when the work list was queued). Items still in flight have not reported their
 * bytes yet, so ending the window at `now` would always read low; once nothing has finished for a
 * whole window, the window does end at `now` and the rate falls toward zero.
 */
export function currentRate({
  now,
  since,
  spans,
}: {
  now: number;
  since: number;
  spans: readonly TransferSpan[];
}): number {
  let latest = since;

  for (const span of spans) {
    latest = Math.max(latest, span.to);
  }

  const windowEnd = now - latest > RATE_WINDOW_MS ? now : latest;
  const windowStart = Math.max(since, windowEnd - RATE_WINDOW_MS);
  const seconds = (windowEnd - windowStart) / 1000;

  if (seconds <= 0) {
    return 0;
  }

  let bytes = 0;

  for (const span of spans) {
    bytes += bytesWithin(span, windowStart, windowEnd);
  }

  return bytes / seconds;
}

/** Milliseconds left at the current rate, or null while there is no rate to go on. */
export function estimateRemainingMs(remainingBytes: number, bytesPerSecond: number): number | null {
  if (remainingBytes <= 0) {
    return 0;
  }

  if (bytesPerSecond <= 0) {
    return null;
  }

  return (remainingBytes / bytesPerSecond) * 1000;
}

/**
 * Throughput over the run as `bucketCount` evenly spaced rates (bytes per second), for the
 * sparkline.
 */
export function throughputSeries({
  bucketCount,
  endedAt,
  spans,
  startedAt,
}: {
  bucketCount: number;
  endedAt: number;
  spans: readonly TransferSpan[];
  startedAt: number;
}): number[] {
  const bucketMs = Math.max(endedAt - startedAt, 1000) / bucketCount;
  const rates = Array.from({ length: bucketCount }, () => 0);

  for (const span of spans) {
    const first = Math.max(0, Math.floor((span.from - startedAt) / bucketMs));
    const last = Math.min(bucketCount - 1, Math.floor((span.to - startedAt) / bucketMs));

    for (let index = first; index <= last; index++) {
      const bucketStart = startedAt + index * bucketMs;
      const bytes = bytesWithin(span, bucketStart, bucketStart + bucketMs);
      rates[index] = (rates[index] ?? 0) + bytes / (bucketMs / 1000);
    }
  }

  return rates;
}

/** `spans` plus `span`, as a new array of at most `MAX_SPANS`. */
export function appendSpan(spans: readonly TransferSpan[], span: TransferSpan): TransferSpan[] {
  const kept: TransferSpan[] = [];

  if (spans.length >= MAX_SPANS) {
    for (let index = 0; index < spans.length; index += 2) {
      const a = spans[index];
      const b = spans[index + 1];

      if (a) {
        kept.push(
          b
            ? { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to), bytes: a.bytes + b.bytes }
            : a,
        );
      }
    }
  } else {
    kept.push(...spans);
  }

  kept.push(span);

  return kept;
}
