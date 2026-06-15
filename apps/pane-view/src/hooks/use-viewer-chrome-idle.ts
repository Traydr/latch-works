import { useCallback, useEffect, useRef, useState } from "react";

const CHROME_IDLE_MS = 2500;

interface UseViewerChromeIdleOptions {
  isMobile: boolean;
  pinned?: boolean;
}

export function useViewerChromeIdle(options: UseViewerChromeIdleOptions): {
  chromeVisible: boolean;
  revealChrome: () => void;
  toggleChrome: () => void;
  chromeVisibilityClass: string;
} {
  const { isMobile, pinned = false } = options;
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

    if (!isMobile && !pinned) {
      idleTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, CHROME_IDLE_MS);
    }
  }, [clearIdleTimer, isMobile, pinned]);

  const toggleChrome = useCallback((): void => {
    if (!isMobile) {
      return;
    }

    setChromeVisible((visible) => !visible);
    clearIdleTimer();
  }, [clearIdleTimer, isMobile]);

  useEffect(() => {
    if (pinned) {
      setChromeVisible(true);
      clearIdleTimer();
      return;
    }

    if (!isMobile) {
      revealChrome();
    }

    return () => {
      clearIdleTimer();
    };
  }, [clearIdleTimer, isMobile, pinned, revealChrome]);

  const chromeVisibilityClass = chromeVisible
    ? "opacity-100"
    : "opacity-0 pointer-events-none";

  return { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass };
}
