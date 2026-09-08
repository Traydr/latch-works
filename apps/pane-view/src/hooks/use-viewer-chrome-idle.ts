import { useCallback, useEffect, useRef, useState } from "react";

const CHROME_IDLE_MS = 2500;

interface UseViewerChromeIdleOptions {
  isMobile: boolean;
  /** Run the idle timer on mobile too (video playback hides its controls everywhere). */
  idleOnMobile?: boolean;
  pinned?: boolean;
}

export interface ViewerChromeIdle {
  chromeVisible: boolean;
  revealChrome: () => void;
  toggleChrome: () => void;
  chromeVisibilityClass: string;
}

export function useViewerChromeIdle(options: UseViewerChromeIdleOptions): ViewerChromeIdle {
  const { isMobile, idleOnMobile = false, pinned = false } = options;
  const idles = (!isMobile || idleOnMobile) && !pinned;
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

    if (idles) {
      idleTimerRef.current = window.setTimeout(() => {
        setChromeVisible(false);
      }, CHROME_IDLE_MS);
    }
  }, [clearIdleTimer, idles]);

  const toggleChrome = useCallback((): void => {
    setChromeVisible((visible) => {
      if (visible) {
        clearIdleTimer();
        return false;
      }
      if (idles) {
        clearIdleTimer();
        idleTimerRef.current = window.setTimeout(() => {
          setChromeVisible(false);
        }, CHROME_IDLE_MS);
      }
      return true;
    });
  }, [clearIdleTimer, idles]);

  useEffect(() => {
    if (pinned) {
      setChromeVisible(true);
      clearIdleTimer();
      return;
    }

    if (idles) {
      revealChrome();
    }

    return () => {
      clearIdleTimer();
    };
  }, [clearIdleTimer, idles, pinned, revealChrome]);

  const chromeVisibilityClass = chromeVisible ? "opacity-100" : "opacity-0 pointer-events-none";

  return { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass };
}
