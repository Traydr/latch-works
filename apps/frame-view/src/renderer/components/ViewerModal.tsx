import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MediaItem } from '../../shared/types';
import { useViewerChromeIdle } from '../hooks/useViewerChromeIdle';
import { useViewerKeyboardControls } from '../hooks/useViewerKeyboardControls';
import { formatBytes, formatDuration, toFileUrl } from '../utils/path';
import { ViewerChrome } from './viewer/ViewerChrome';
import { ViewerVideoControls } from './viewer/ViewerVideoControls';

interface ViewerModalProps {
  items: MediaItem[];
  index: number;
  autoplayVideos: boolean;
  loopVideos: boolean;
  canStepBackward: boolean;
  canStepForward: boolean;
  onClose: () => void;
  onStep: (delta: number) => void;
}

const VIEWER_VOLUME_STORAGE_KEY = 'frameview.viewer.volume';

function readPersistedVolume(): number {
  try {
    const raw = window.localStorage.getItem(VIEWER_VOLUME_STORAGE_KEY);
    if (!raw) {
      return 1;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 1;
    }

    return Math.max(0, Math.min(1, parsed));
  } catch {
    return 1;
  }
}

function buildViewerDetails(item: MediaItem, loadedDuration: number): string[] {
  const resolvedDurationMs =
    item.mediaType === 'video'
      ? item.durationMs && item.durationMs > 0
        ? item.durationMs
        : loadedDuration > 0
          ? Math.round(loadedDuration * 1000)
          : undefined
      : undefined;

  return [
    formatBytes(item.size),
    item.extension.toUpperCase(),
    ...(resolvedDurationMs ? [formatDuration(resolvedDurationMs)] : []),
    ...(item.width && item.height ? [`${item.width}x${item.height}`] : []),
    ...(item.codec ? [item.codec] : []),
  ];
}

export function ViewerModal({
  items,
  index,
  autoplayVideos,
  loopVideos,
  canStepBackward,
  canStepForward,
  onClose,
  onStep,
}: ViewerModalProps): JSX.Element | null {
  const item = useMemo(() => items[index], [items, index]);
  const isVideoItem = item?.mediaType === 'video';
  const modalRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isScrubbingRef = useRef(false);
  const queuedStepRef = useRef(0);
  const stepFrameRef = useRef<number | null>(null);
  const speedBoostHeldRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(() => readPersistedVolume());
  const [speed, setSpeed] = useState(1);

  const chromePinned = isVideoItem && !playing;
  const { chromeVisible, revealChrome, chromeVisibilityClass } = useViewerChromeIdle({
    pinned: chromePinned,
  });

  useEffect(() => {
    const dialog = modalRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const applySpeed = useCallback((nextSpeed: number): void => {
    setSpeed(nextSpeed);

    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
  }, []);

  const queueStep = useCallback(
    (delta: number): void => {
      queuedStepRef.current += delta;
      if (stepFrameRef.current !== null) {
        return;
      }

      stepFrameRef.current = window.requestAnimationFrame(() => {
        stepFrameRef.current = null;
        const pendingDelta = queuedStepRef.current;
        queuedStepRef.current = 0;

        if (pendingDelta !== 0) {
          onStep(pendingDelta);
        }
      });
    },
    [onStep],
  );

  useEffect(() => {
    return () => {
      if (stepFrameRef.current !== null) {
        window.cancelAnimationFrame(stepFrameRef.current);
      }
      stepFrameRef.current = null;
      queuedStepRef.current = 0;
    };
  }, []);

  useViewerKeyboardControls({
    applySpeed,
    isVideoItem,
    item,
    onChangePosition: setPosition,
    onClose,
    queueStep,
    revealChrome,
    speedBoostHeldRef,
    videoRef,
  });

  if (!item) {
    return null;
  }

  const details = buildViewerDetails(item, duration);
  const canSeek = Number.isFinite(duration) && duration > 0;

  const commitSeek = (rawTarget: number): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const total = video.duration;
    if (!Number.isFinite(total) || total <= 0) {
      return;
    }

    const safeTotal = Math.max(0, total - 0.05);
    const nextTime = Math.max(0, Math.min(safeTotal, rawTarget));
    const wasPlaying = !video.paused;

    if ('fastSeek' in video && typeof video.fastSeek === 'function') {
      video.fastSeek(nextTime);
    } else {
      video.currentTime = nextTime;
    }

    setPosition(nextTime);

    if (wasPlaying) {
      void video.play().catch(() => {
        // Keep paused if resume cannot start.
      });
    }
  };

  const toggleVideoPlayback = (): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  };

  const skip = (seconds: number): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const total = video.duration;
    if (!Number.isFinite(total) || total <= 0) {
      return;
    }

    commitSeek(video.currentTime + seconds);
  };

  const toggleFullscreen = async (): Promise<void> => {
    if (!modalRef.current) {
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await modalRef.current.requestFullscreen();
  };

  const changeVolume = (nextVolume: number): void => {
    const clamped = Math.max(0, Math.min(1, nextVolume));
    setVolume(clamped);
    try {
      window.localStorage.setItem(VIEWER_VOLUME_STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage write errors.
    }
    if (videoRef.current) {
      videoRef.current.volume = clamped;
    }
  };

  const changeSpeed = (nextSpeed: number): void => {
    speedBoostHeldRef.current = false;
    applySpeed(nextSpeed);
  };

  return (
    <dialog
      ref={modalRef}
      aria-label={`Viewer for ${item.name}`}
      className={`dark fixed inset-0 z-50 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-zinc-950/95 p-0 text-zinc-100 backdrop:bg-zinc-950 ${chromeVisible ? '' : 'cursor-none'}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      <ViewerChrome
        canStepBackward={canStepBackward}
        canStepForward={canStepForward}
        chromeVisibilityClass={chromeVisibilityClass}
        details={details}
        item={item}
        onClose={onClose}
        onStep={onStep}
        onToggleFullscreen={() => void toggleFullscreen()}
      />

      {/* Center media */}
      <div className="flex h-full items-center justify-center p-3">
        {item.mediaType === 'image' ? (
          <img
            src={toFileUrl(item.path)}
            alt={item.name}
            className="max-h-full max-w-full object-contain [outline:1px_solid_rgba(255,255,255,0.1)]"
          />
        ) : (
          <video
            key={item.id}
            ref={videoRef}
            src={toFileUrl(item.path)}
            className="max-h-full max-w-full bg-black object-contain"
            autoPlay={autoplayVideos}
            loop={loopVideos}
            preload="auto"
            playsInline
            onLoadedMetadata={(event) => {
              const loadedDuration = event.currentTarget.duration;
              event.currentTarget.volume = volume;
              event.currentTarget.playbackRate = speed;
              if (Number.isFinite(loadedDuration)) {
                setDuration(loadedDuration);
              }
              if (autoplayVideos) {
                void event.currentTarget.play().catch(() => {
                  // Ignore autoplay failures caused by platform policy.
                });
              }
            }}
            onDurationChange={(event) => {
              const nextDuration = event.currentTarget.duration;
              if (Number.isFinite(nextDuration)) {
                setDuration(nextDuration);
              }
            }}
            onTimeUpdate={(event) => {
              if (!isScrubbingRef.current) {
                setPosition(event.currentTarget.currentTime || 0);
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={(event) => {
              if (loopVideos) {
                event.currentTarget.currentTime = 0;
                void event.currentTarget.play().catch(() => {
                  // Keep ended state if replay cannot start.
                });
              } else {
                setPlaying(false);
              }
            }}
          />
        )}
      </div>

      {/* Video controls */}
      {item.mediaType === 'video' ? (
        <ViewerVideoControls
          canSeek={canSeek}
          chromeVisibilityClass={chromeVisibilityClass}
          duration={duration}
          onChangePosition={setPosition}
          onChangeScrubbing={(scrubbing) => {
            isScrubbingRef.current = scrubbing;
          }}
          onChangeSpeed={changeSpeed}
          onChangeVolume={changeVolume}
          onCommitSeek={commitSeek}
          onSkip={skip}
          onTogglePlayback={toggleVideoPlayback}
          playing={playing}
          position={position}
          speed={speed}
          volume={volume}
        />
      ) : null}
    </dialog>
  );
}
