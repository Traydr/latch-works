export function formatError(error: unknown): string {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && "message" in error) {
    const message = error.message;
    return typeof message === "string" ? message : String(message);
  }

  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (isAbortError(reason)) {
      throw reason;
    }
    const error = new DOMException("The operation was aborted.", "AbortError");
    throw error;
  }
}
