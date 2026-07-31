import type { MediaItem } from "@latch-works/media-domain";
import { type JSX, useCallback, useState } from "react";
import { MediaViewerSession } from "./MediaViewerSession";

interface MediaViewerModalProps {
  autoplayVideos: boolean;
  items: MediaItem[];
  loopNavigation: boolean;
  loopVideos: boolean;
  onClose: () => void;
  rememberViewerPosition: boolean;
  startIndex: number;
}

export function MediaViewerModal({
  autoplayVideos,
  items,
  loopNavigation,
  loopVideos,
  onClose,
  rememberViewerPosition,
  startIndex,
}: MediaViewerModalProps): JSX.Element | null {
  const [index, setIndex] = useState(startIndex);
  const item = items[index];
  const step = useCallback(
    (delta: -1 | 1) => {
      setIndex((currentIndex) => {
        if (items.length === 0) {
          return 0;
        }
        return loopNavigation
          ? (currentIndex + delta + items.length) % items.length
          : Math.max(0, Math.min(items.length - 1, currentIndex + delta));
      });
    },
    [items.length, loopNavigation],
  );

  if (!item) {
    return null;
  }

  return (
    <MediaViewerSession
      key={item.id}
      autoplayVideos={autoplayVideos}
      canStepBackward={loopNavigation || index > 0}
      canStepForward={loopNavigation || index < items.length - 1}
      item={item}
      loopVideos={loopVideos}
      onClose={onClose}
      onStep={step}
      rememberViewerPosition={rememberViewerPosition}
    />
  );
}
