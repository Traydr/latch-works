import { type ReactNode, useCallback, useState } from "react";
import { OriginalDialog, type OriginalItem } from "./OriginalDialog";
import { originalUrl } from "./original-url";

/** True in an app opened from the Home Screen, which has no tabs or address bar. */
function isStandaloneApp(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches;
}

export interface OpenOriginal {
  openOriginal: (item: OriginalItem) => void;
  /** The dialog an installed app shows the original in; render it while it is not null. */
  originalDialog: ReactNode;
}

/**
 * Opens an item's original file. A browser gets a new tab. An installed app has no tabs: iOS
 * shows the new window over the app with no way back to it (plan 066, D3), so the app shows the
 * original in its own dialog instead, which the caller renders as `originalDialog`.
 */
export function useOpenOriginal(): OpenOriginal {
  const [shown, setShown] = useState<OriginalItem | null>(null);

  const openOriginal = useCallback((item: OriginalItem) => {
    if (isStandaloneApp()) {
      setShown(item);
    } else {
      window.open(originalUrl(item.id), "_blank", "noopener,noreferrer");
    }
  }, []);

  const originalDialog =
    shown === null ? null : <OriginalDialog item={shown} onClose={() => setShown(null)} />;

  return { openOriginal, originalDialog };
}
