import { FolderOpen, Maximize, Pause, Play, X } from 'lucide-react';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MediaItem } from '../../shared/types';
import { useViewerChromeIdle } from '../hooks/useViewerChromeIdle';
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

  const chromePinned = isVideoItem && !playing;
  const { chromeVisible, revealChrome, chromeVisibilityClass } = useViewerChromeIdle({
    pinned: chromePinned,
  });

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

  useEffect(() => {
    if (!item) {
      return;
    }

    const keyListener = (event: KeyboardEvent): void => {
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
  }, [applySpeed, isVideoItem, item, onClose, queueStep, revealChrome]);

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
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewer for ${item.name}`}
      className={`dark fixed inset-0 z-50 bg-zinc-950/95 text-zinc-100 ${chromeVisible ? '' : 'cursor-none'}`}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      {/* Top bar: filename + actions */}
      <div
        className={`viewer-scrim-top viewer-chrome-transition ${chromeVisibilityClass}`}
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <div className="pointer-events-auto flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{item.name}</p>
            <p className="truncate text-xs text-white/70">{details.join(' · ')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="size-5" />
            </button>
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Fullscreen"
              aria-label="Fullscreen"
              onClick={() => void toggleFullscreen()}
            >
              <Maximize className="size-5" />
            </button>
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Reveal in folder"
              aria-label="Reveal in folder"
              onClick={() => void window.frameView.revealInFolder(item.path)}
            >
              <FolderOpen className="size-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Side navigation */}
      <button
        type="button"
        aria-label="Previous item"
        className={`viewer-overlay-btn absolute left-3 top-1/2 z-20 -translate-y-1/2 viewer-chrome-transition ${chromeVisibilityClass} ${canStepBackward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(-1)}
        disabled={!canStepBackward}
      >
        <span className="px-1 text-xl">{'<'}</span>
      </button>
      <button
        type="button"
        aria-label="Next item"
        className={`viewer-overlay-btn absolute right-3 top-1/2 z-20 -translate-y-1/2 viewer-chrome-transition ${chromeVisibilityClass} ${canStepForward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(1)}
        disabled={!canStepForward}
      >
        <span className="px-1 text-xl">{'>'}</span>
      </button>

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
        <div
          className={`viewer-scrim-bottom viewer-chrome-transition ${chromeVisibilityClass}`}
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          <div className="pointer-events-auto space-y-2">
            <input
              type="range"
              min={0}
              max={canSeek ? duration : 1}
              step={0.1}
              value={position}
              className="viewer-accent-range w-full"
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
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/90">
              <button
                type="button"
                className="viewer-overlay-btn"
                title={playing ? 'Pause' : 'Play'}
                aria-label={playing ? 'Pause' : 'Play'}
                onClick={toggleVideoPlayback}
              >
                {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
              </button>
              <button type="button" className="viewer-overlay-btn-text" onClick={() => skip(-5)}>
                -5s
              </button>
              <button type="button" className="viewer-overlay-btn-text" onClick={() => skip(5)}>
                +5s
              </button>
              <label className="flex items-center gap-2 text-white/80">
                Vol
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  className="viewer-accent-range"
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
              <label className="flex items-center gap-2 text-white/80">
                Speed
                <select
                  className="rounded-lg border-0 bg-white/15 px-2 py-1 text-xs text-white outline-none"
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
              </label>
              <span className="text-white/70 tabular-nums">
                {Math.floor(position)}/{Math.floor(duration || 0)}s
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
