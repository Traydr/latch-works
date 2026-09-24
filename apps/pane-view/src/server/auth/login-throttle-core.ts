const MAX_FAILED_ATTEMPTS = 5;

const WINDOW_MS = 5 * 60 * 1000;

export interface LoginThrottleStore {
  clear(keys: string[]): Promise<void>;
  /**
   * Atomically counts one attempt against every key and returns each key's
   * count within its current window, including this attempt. Concurrent calls
   * must each observe a distinct count, so a burst cannot all read the same
   * pre-attempt total.
   */
  reserve(keys: string[], now: number, expiresAt: number): Promise<number[]>;
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

    /**
     * Counts an attempt before the credentials are checked and reports whether
     * it may proceed. Every attempt counts as a failure until a successful
     * sign-in clears the buckets, so parallel guesses cannot slip past the
     * limit between a check and a later write.
     */
    async reserveLoginAttempt(ip: string, username: string): Promise<boolean> {
      const currentTime = now();
      const counts = await store.reserve(keys(ip, username), currentTime, currentTime + WINDOW_MS);

      return counts.every((count) => count <= MAX_FAILED_ATTEMPTS);
    },
  };
}
