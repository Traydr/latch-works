import { useEffect, useEffectEvent } from 'react';

import { HOTKEYS, isPlainHotkeyEvent, isTextInputTarget, matchesAnyKey } from '../utils/hotkeys';
import { VIDEO_SKIP_SECONDS } from '../utils/videoPlayback';
import type { ViewerVideoModel } from './useViewerVideoModel';

interface UseViewerKeyboardControlsOptions {
  isVideoItem: boolean;
  model: ViewerVideoModel;
  onClose: () => void;
  queueStep: (delta: number) => void;
  revealChrome: () => void;
}

/** Window-level hotkeys while the viewer is open; video keys drive the playback model. */
export function useViewerKeyboardControls({
  isVideoItem,
  model,
  onClose,
  queueStep,
  revealChrome,
}: UseViewerKeyboardControlsOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
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
      model.toggleVideoPlayback();
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoSeekBackward)) {
      event.preventDefault();
      model.skip(-VIDEO_SKIP_SECONDS);
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoSeekForward)) {
      event.preventDefault();
      model.skip(VIDEO_SKIP_SECONDS);
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoMute)) {
      event.preventDefault();
      model.toggleMute();
      return;
    }

    if (matchesAnyKey(event, HOTKEYS.videoTemporarySpeed)) {
      event.preventDefault();
      model.beginHoldBoost();
    }
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent): void => {
    if (isPlainHotkeyEvent(event) && matchesAnyKey(event, HOTKEYS.videoTemporarySpeed)) {
      model.endHoldBoost();
    }
  });

  const releaseHeldSpeed = useEffectEvent((): void => {
    model.endHoldBoost();
  });

  useEffect(() => {
    const keyDownListener = (event: KeyboardEvent): void => handleKeyDown(event);
    const keyUpListener = (event: KeyboardEvent): void => handleKeyUp(event);
    const blurListener = (): void => releaseHeldSpeed();

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
