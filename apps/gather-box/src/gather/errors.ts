import { z } from "zod";

/** A rejected promise can carry a bare string or a plain object rather than an Error. */
const ThrownMessageSchema = z.union([
  z.string(),
  z.object({ message: z.string() }).transform((thrown) => thrown.message)
]);

/**
 * JavaScript allows any value to be thrown, so a `catch` binding is the boundary where one
 * becomes an Error. Everything downstream takes `Error` and reads `message` and `name` directly.
 */
export function toError(cause: unknown): Error {
  if (cause instanceof Error) {
    return cause;
  }

  const thrown = ThrownMessageSchema.safeParse(cause);
  if (thrown.success) {
    return new Error(thrown.data || "Unknown error", { cause });
  }

  return new Error(
    cause === null || cause === undefined ? "Unknown error" : String(cause),
    { cause }
  );
}

export function formatError(error: Error): string {
  return error.message;
}

export function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = toError(signal.reason);
  throw isAbortError(reason) ? reason : new DOMException("The operation was aborted.", "AbortError");
}
