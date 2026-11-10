import { z } from "zod";

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

/** Why `signal` aborted: its reason, or a plain AbortError when it was given none. */
export function abortError(signal?: AbortSignal): Error {
  return toError(signal?.reason ?? new DOMException("Aborted", "AbortError"));
}

export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/** An error with its cause's message, which is often the useful part (ECONNREFUSED…). */
export function formatError(error: Error): string {
  const cause = error.cause;

  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`;
  }

  return error.message;
}

/** Node's fs rejections carry an errno `code`; these mean nothing exists at the path. */
const MissingPathErrorSchema = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) });

export function isMissingPathError(cause: unknown): boolean {
  return MissingPathErrorSchema.safeParse(cause).success;
}
