const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;

interface AttemptRecord {
  count: number;
  expiresAt: number;
  key: string;
  windowStart: number;
}

export interface LoginThrottleStore {
  clear(keys: string[]): Promise<void>;
  /**
   * Returns whatever rows exist for `keys`. Implementations may return expired
   * records — the caller filters on `expiresAt`, so a store is free to keep the
   * read path free of writes and prune elsewhere.
   */
  read(keys: string[], now: number): Promise<AttemptRecord[]>;
  record(keys: string[], now: number, expiresAt: number): Promise<void>;
}

function throttleKey(ip: string, username: string): string {
  return `${ip}:${username.trim().toLowerCase()}`;
}

function usernameThrottleKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

export function createLoginThrottle({
  now = Date.now,
  store,
}: {
  now?: () => number;
  store: LoginThrottleStore;
}) {
  function keys(ip: string, username: string): string[] {
    return [throttleKey(ip, username), usernameThrottleKey(username)];
  }

  return {
    async clearLoginThrottle(ip: string, username: string): Promise<void> {
      await store.clear(keys(ip, username));
    },

    async isLoginThrottled(ip: string, username: string): Promise<boolean> {
      const currentTime = now();
      const records = await store.read(keys(ip, username), currentTime);
      return records.some(
        (record) => record.expiresAt >= currentTime && record.count >= MAX_FAILED_ATTEMPTS,
      );
    },

    async recordFailedLogin(ip: string, username: string): Promise<void> {
      const currentTime = now();
      await store.record(keys(ip, username), currentTime, currentTime + WINDOW_MS);
    },
  };
}
