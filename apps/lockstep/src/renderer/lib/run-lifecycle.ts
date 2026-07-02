export function shouldEndRunOnComplete(
  summaryAction: string,
  activeRunAction: string,
): boolean {
  if (summaryAction === "plan" && (activeRunAction === "push" || activeRunAction === "prune")) {
    return false;
  }
  return true;
}

export function isElapsedClockActive(
  running: boolean,
  startedAt: number | null,
  endedAt: number | null,
): boolean {
  return running || (startedAt != null && endedAt == null);
}
