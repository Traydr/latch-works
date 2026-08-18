import { formatBytes } from "@latch-works/media-domain";

export { formatBytes };

export function formatPushError(error: Error): string {
  const cause = error.cause;
  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`;
  }

  return error.message;
}

/** Thrown values are `unknown` by design; wrap anything that is not already an `Error`. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}
