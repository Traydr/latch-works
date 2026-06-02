import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MediaItem } from '../../shared/types';
import { HOTKEYS, isPlainHotkeyEvent, isTextInputTarget, matchesAnyKey } from '../utils/hotkeys';
import { formatBytes, formatDuration, toFileUrl } from '../utils/path';

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
  const modalRef = useRef<HTMLDivElement | null>(null);
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

  const applySpeed = useCallback((nextSpeed: number): void => {
    setSpeed(nextSpeed);

    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
  }, []);

  useEffect(() => {
    setPlaying(false);
    setDuration(0);
    setPosition(0);
    speedBoostHeldRef.current = false;
    setSpeed(1);
  }, [item]);

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

  useEffect(() => {
    if (!item) {
      return;
    }

    const keyListener = (event: KeyboardEvent): void => {
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

        setPosition(nextTime);

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
    };

    const keyUpListener = (event: KeyboardEvent): void => {
      if (!isPlainHotkeyEvent(event)) {
        return;
      }

      if (!matchesAnyKey(event, HOTKEYS.videoTemporarySpeed) || !speedBoostHeldRef.current) {
        return;
      }

      speedBoostHeldRef.current = false;
      applySpeed(1);
    };

    const resetHeldSpeed = (): void => {
      if (!speedBoostHeldRef.current) {
        return;
      }

      speedBoostHeldRef.current = false;
      applySpeed(1);
    };

    window.addEventListener('keydown', keyListener);
    window.addEventListener('keyup', keyUpListener);
    window.addEventListener('blur', resetHeldSpeed);
    return () => {
      window.removeEventListener('keydown', keyListener);
      window.removeEventListener('keyup', keyUpListener);
      window.removeEventListener('blur', resetHeldSpeed);
    };
  }, [applySpeed, isVideoItem, item, onClose, queueStep]);

  if (!item) {
    return null;
  }

  const resolvedDurationMs =
    item.mediaType === 'video'
      ? item.durationMs && item.durationMs > 0
        ? item.durationMs
        : duration > 0
          ? Math.round(duration * 1000)
          : undefined
      : undefined;

  const details = [
    formatBytes(item.size),
    item.extension.toUpperCase(),
    ...(resolvedDurationMs ? [formatDuration(resolvedDurationMs)] : []),
    ...(item.width && item.height ? [`${item.width}x${item.height}`] : []),
    ...(item.codec ? [item.codec] : []),
  ];

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

  return (
    <div ref={modalRef} className="dark fixed inset-0 z-50 bg-zinc-950/95 text-zinc-100">
      <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(94vw,980px)] -translate-x-1/2">
        <div className="prism-surface pointer-events-auto flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
            <p className="text-xs text-zinc-300">{details.join(' | ')}</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className="prism-btn"
              onClick={() => void window.frameView.revealInFolder(item.path)}
            >
              Reveal
            </button>
            <button type="button" className="prism-btn" onClick={() => void toggleFullscreen()}>
              Fullscreen
            </button>
            <button type="button" className="prism-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`prism-surface absolute left-4 top-1/2 z-20 -translate-y-1/2 p-3 text-xl ${canStepBackward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(-1)}
        disabled={!canStepBackward}
      >
        {'<'}
      </button>
      <button
        type="button"
        className={`prism-surface absolute right-4 top-1/2 z-20 -translate-y-1/2 p-3 text-xl ${canStepForward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(1)}
        disabled={!canStepForward}
      >
        {'>'}
      </button>

      <div className="flex h-full items-center justify-center p-12 pt-24">
        {item.mediaType === 'image' ? (
          <img
            src={toFileUrl(item.path)}
            alt={item.name}
            className="max-h-full max-w-full rounded object-contain"
          />
        ) : (
          <video
            key={item.id}
            ref={videoRef}
            src={toFileUrl(item.path)}
            className="max-h-full max-w-full rounded bg-black"
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

      {item.mediaType === 'video' ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 w-[min(94vw,980px)] -translate-x-1/2">
          <div className="prism-surface pointer-events-auto space-y-2 px-4 py-3">
            <input
              type="range"
              min={0}
              max={canSeek ? duration : 1}
              step={0.1}
              value={position}
              className="w-full accent-violet-500"
              disabled={!canSeek}
              onPointerDown={() => {
                isScrubbingRef.current = true;
              }}
              onPointerCancel={() => {
                isScrubbingRef.current = false;
              }}
              onBlur={() => {
                isScrubbingRef.current = false;
              }}
              onPointerUp={(event) => {
                if (!canSeek) {
                  isScrubbingRef.current = false;
                  return;
                }

                const next = Number((event.currentTarget as HTMLInputElement).value);
                commitSeek(next);
                isScrubbingRef.current = false;
              }}
              onInput={(event) => {
                const next = Number((event.currentTarget as HTMLInputElement).value);
                setPosition(next);
              }}
              onChange={(event) => {
                if (!canSeek) {
                  return;
                }

                const next = Number(event.target.value);
                commitSeek(next);
              }}
            />
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
              <button type="button" className="prism-btn" onClick={toggleVideoPlayback}>
                {playing ? 'Pause' : 'Play'}
              </button>
              <button type="button" className="prism-btn" onClick={() => skip(-5)}>
                -5s
              </button>
              <button type="button" className="prism-btn" onClick={() => skip(5)}>
                +5s
              </button>
              <label className="flex items-center gap-2 text-zinc-300">
                Volume
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  className="accent-violet-500"
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    const clamped = Math.max(0, Math.min(1, next));
                    setVolume(clamped);
                    try {
                      window.localStorage.setItem(VIEWER_VOLUME_STORAGE_KEY, String(clamped));
                    } catch {
                      // Ignore storage write errors.
                    }
                    if (videoRef.current) {
                      videoRef.current.volume = clamped;
                    }
                  }}
                />
              </label>
              <label className="flex items-center gap-2 text-zinc-300">
                Speed
                <div className="relative">
                  <select
                    className="prism-select"
                    value={speed}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      speedBoostHeldRef.current = false;
                      applySpeed(next);
                    }}
                  >
                    <option value={0.5}>0.5x</option>
                    <option value={1}>1x</option>
                    <option value={1.5}>1.5x</option>
                    <option value={2}>2x</option>
                  </select>
                </div>
              </label>
              <span className="text-zinc-300">
                {Math.floor(position)}/{Math.floor(duration || 0)}s
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
