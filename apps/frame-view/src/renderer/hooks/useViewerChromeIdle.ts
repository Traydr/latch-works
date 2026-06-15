import { useCallback, useEffect, useRef, useState } from 'react';

const CHROME_IDLE_MS = 2500;

interface UseViewerChromeIdleOptions {
  pinned?: boolean;
}

export function useViewerChromeIdle(options: UseViewerChromeIdleOptions = {}): {
  chromeVisible: boolean;
  revealChrome: () => void;
  chromeVisibilityClass: string;
} {
  const { pinned = false } = options;
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const revealChrome = useCallback((): void => {
    setChromeVisible(true);
    clearIdleTimer();

    if (!pinned) {
      idleTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, CHROME_IDLE_MS);
    }
  }, [clearIdleTimer, pinned]);

  useEffect(() => {
    if (pinned) {
      setChromeVisible(true);
      clearIdleTimer();
      return;
    }

    revealChrome();

    return () => {
      clearIdleTimer();
    };
  }, [clearIdleTimer, pinned, revealChrome]);

  const chromeVisibilityClass = chromeVisible ? 'opacity-100' : 'opacity-0 pointer-events-none';

  return { chromeVisible, revealChrome, chromeVisibilityClass };
}
