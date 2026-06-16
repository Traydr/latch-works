type LogFields = Record<string, boolean | number | string | null | undefined>;

export function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "unknown error";
}

export function excerpt(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export function logOptimizerEvent(event: string, fields: LogFields = {}): void {
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

export function logOptimizerError(event: string, fields: LogFields = {}): void {
  const payload: Record<string, unknown> = {
    event,
    ts: new Date().toISOString(),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      payload[key] = value;
    }
  }

  console.error(JSON.stringify(payload));
}
