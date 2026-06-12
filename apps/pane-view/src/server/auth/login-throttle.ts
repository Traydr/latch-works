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

function usernameThrottleKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

function isBucketThrottled(key: string, now: number): boolean {
  const record = attemptsByKey.get(key);
  if (!record) {
    return false;
  }

  if (now - record.windowStart > WINDOW_MS) {
    attemptsByKey.delete(key);
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

function recordAttempt(key: string, now: number): void {
  const record = attemptsByKey.get(key);

  if (!record || now - record.windowStart > WINDOW_MS) {
    attemptsByKey.set(key, { count: 1, windowStart: now });
    return;
  }

  record.count += 1;
}

export function isLoginThrottled(ip: string, username: string): boolean {
  const now = Date.now();
  return (
    isBucketThrottled(throttleKey(ip, username), now) ||
    isBucketThrottled(usernameThrottleKey(username), now)
  );
}

export function recordFailedLogin(ip: string, username: string): void {
  const now = Date.now();
  pruneExpiredAttempts(now);
  recordAttempt(throttleKey(ip, username), now);
  recordAttempt(usernameThrottleKey(username), now);
}

export function clearLoginThrottle(ip: string, username: string): void {
  attemptsByKey.delete(throttleKey(ip, username));
  attemptsByKey.delete(usernameThrottleKey(username));
}

export function resetLoginThrottleForTests(): void {
  attemptsByKey.clear();
}
