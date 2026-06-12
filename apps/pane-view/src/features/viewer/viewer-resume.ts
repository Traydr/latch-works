export const VIEWER_STATE_SAVE_DEBOUNCE_MS = 3_000;

export function resolveVideoResumeSeconds(
  positionMs: number | undefined,
  durationSeconds: number,
): number | null {
  if (positionMs === undefined || !Number.isFinite(positionMs) || positionMs < 0) {
    return null;
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }

  const resumeSeconds = positionMs / 1_000;
  const maxSeconds = Math.max(0, durationSeconds - 1);
  return Math.max(0, Math.min(maxSeconds, resumeSeconds));
}

export function videoSecondsToPositionMs(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1_000));
}
