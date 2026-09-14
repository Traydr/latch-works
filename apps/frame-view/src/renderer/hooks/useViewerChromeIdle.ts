import { useCallback, useEffect, useRef, useState } from 'react';

const CHROME_IDLE_MS = 2500;

interface UseViewerChromeIdleOptions {
  pinned?: boolean;
}

/** Viewer chrome visibility, its reveal and toggle triggers, and the class that fades it out. */
interface ViewerChromeIdleState {
  chromeVisible: boolean;
  revealChrome: () => void;
  toggleChrome: () => void;
  chromeVisibilityClass: string;
}

export function useViewerChromeIdle(
  options: UseViewerChromeIdleOptions = {},
): ViewerChromeIdleState {
  const { pinned = false } = options;
  const [chromeVisible, setChromeVisible] = useState(true);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const armIdleTimer = useCallback((): void => {
    clearIdleTimer();
    if (!pinned) {
      idleTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, CHROME_IDLE_MS);
    }
  }, [clearIdleTimer, pinned]);

  const revealChrome = useCallback((): void => {
    setChromeVisible(true);
    armIdleTimer();
  }, [armIdleTimer]);

  /** A tap on the picture shows hidden chrome or hides visible chrome. */
  const toggleChrome = useCallback((): void => {
    setChromeVisible((visible) => {
      if (visible) {
        clearIdleTimer();
        return false;
      }
      armIdleTimer();
      return true;
    });
  }, [armIdleTimer, clearIdleTimer]);

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

  return { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass };
}
