type TelemetryFields = Record<string, string | number | boolean | undefined>;

/**
 * Emits a single-line JSON event for derivative observability. Centralized so
 * the request-storm baseline (resolve outcomes, generation duration, snapshot
 * embed hit rate) can be measured before and after the optimizer work.
 */
export function logDerivativeEvent(event: string, fields: TelemetryFields = {}): void {
  const payload: Record<string, unknown> = {
    event,
    ts: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  console.info(JSON.stringify(payload));
}
