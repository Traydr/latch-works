const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

interface AttemptRecord {
  count: number;
  windowStart: number;
}

const attemptsByKey = new Map<string, AttemptRecord>();

function throttleKey(ip: string, username: string): string {
  return `${ip}:${username.trim().toLowerCase()}`;
}

export function isLoginThrottled(ip: string, username: string): boolean {
  const record = attemptsByKey.get(throttleKey(ip, username));
  if (!record) {
    return false;
  }

  if (Date.now() - record.windowStart > WINDOW_MS) {
    attemptsByKey.delete(throttleKey(ip, username));
    return false;
  }

  return record.count >= MAX_FAILED_ATTEMPTS;
}

function pruneExpiredAttempts(now: number): void {
  for (const [key, record] of attemptsByKey) {
    if (now - record.windowStart > WINDOW_MS) {
      attemptsByKey.delete(key);
    }
  }
}

export function recordFailedLogin(ip: string, username: string): void {
  const key = throttleKey(ip, username);
  const now = Date.now();
  pruneExpiredAttempts(now);
  const record = attemptsByKey.get(key);

  if (!record || now - record.windowStart > WINDOW_MS) {
    attemptsByKey.set(key, { count: 1, windowStart: now });
    return;
  }

  record.count += 1;
}

export function clearLoginThrottle(ip: string, username: string): void {
  attemptsByKey.delete(throttleKey(ip, username));
}

export function resetLoginThrottleForTests(): void {
  attemptsByKey.clear();
}
