export const derivativeProcessingLeaseMs = 10 * 60 * 1000;

export function isDerivativeProcessingLeaseExpired(
  updatedAt: Date,
  now = Date.now(),
): boolean {
  return now - updatedAt.getTime() >= derivativeProcessingLeaseMs;
}
