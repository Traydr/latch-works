import { type MutableRefObject, type RefObject, useEffect, useEffectEvent } from 'react';

import type { MediaItem } from '../../shared/types';
import { HOTKEYS, isPlainHotkeyEvent, isTextInputTarget, matchesAnyKey } from '../utils/hotkeys';

interface UseViewerKeyboardControlsOptions {
  applySpeed: (speed: number) => void;
  isVideoItem: boolean;
  item: MediaItem | undefined;
  onChangePosition: (position: number) => void;
  onClose: () => void;
  queueStep: (delta: number) => void;
  revealChrome: () => void;
  speedBoostHeldRef: MutableRefObject<boolean>;
  videoRef: RefObject<HTMLVideoElement | null>;
}

export function useViewerKeyboardControls({
  applySpeed,
  isVideoItem,
  item,
  onChangePosition,
  onClose,
  queueStep,
  revealChrome,
  speedBoostHeldRef,
  videoRef,
}: UseViewerKeyboardControlsOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (!item) {
      return;
    }

    revealChrome();

    if (isTextInputTarget(event.target) && !matchesAnyKey(event, HOTKEYS.close)) {
      return;
    }

    if (!isPlainHotkeyEvent(event)) {
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.close)) {
      onClose();
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.viewerNext)) {
      event.preventDefault();
      queueStep(1);
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.viewerPrevious)) {
      event.preventDefault();
      queueStep(-1);
      return;
    }

    if (!isVideoItem) {
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoPlayPause)) {
      event.preventDefault();
      const video = videoRef.current;
      if (!video) {
        return;
      }

      if (video.paused) {
        void video.play();
      } else {
        video.pause();
      }

      return;
    }

    if (matchesAnyKey(event, [...HOTKEYS.videoSeekBackward, ...HOTKEYS.videoSeekForward])) {
      event.preventDefault();
      const video = videoRef.current;
      if (!video) {
        return;
      }

      const total = video.duration;
      if (!Number.isFinite(total) || total <= 0) {
        return;
      }

      const targetTime =
        video.currentTime + (matchesAnyKey(event, HOTKEYS.videoSeekBackward) ? -5 : 5);
      const safeTotal = Math.max(0, total - 0.05);
      const nextTime = Math.max(0, Math.min(safeTotal, targetTime));
      const wasPlaying = !video.paused;

      if ('fastSeek' in video && typeof video.fastSeek === 'function') {
        video.fastSeek(nextTime);
      } else {
        video.currentTime = nextTime;
      }

      onChangePosition(nextTime);

      if (wasPlaying) {
        void video.play().catch(() => {
          // Keep paused if resume cannot start.
        });
      }

      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoTemporarySpeed)) {
      event.preventDefault();
      speedBoostHeldRef.current = true;
      applySpeed(2);
    }
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent): void => {
    if (!isPlainHotkeyEvent(event)) {
      return;
    }

    if (!matchesAnyKey(event, HOTKEYS.videoTemporarySpeed) || !speedBoostHeldRef.current) {
      return;
    }

    speedBoostHeldRef.current = false;
    applySpeed(1);
  });

  const resetHeldSpeed = useEffectEvent((): void => {
    if (!speedBoostHeldRef.current) {
      return;
    }

    speedBoostHeldRef.current = false;
    applySpeed(1);
  });

  useEffect(() => {
    const keyDownListener = (event: KeyboardEvent): void => handleKeyDown(event);
    const keyUpListener = (event: KeyboardEvent): void => handleKeyUp(event);
    const blurListener = (): void => resetHeldSpeed();

    window.addEventListener('keydown', keyDownListener);
    window.addEventListener('keyup', keyUpListener);
    window.addEventListener('blur', blurListener);
    return () => {
      window.removeEventListener('keydown', keyDownListener);
      window.removeEventListener('keyup', keyUpListener);
      window.removeEventListener('blur', blurListener);
    };
  }, []);
}
