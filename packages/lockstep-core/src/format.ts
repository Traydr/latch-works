import { formatBytes } from "@latch-works/media-domain";

export { formatBytes };

export function formatPushError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`;
  }

  return error.message;
}
