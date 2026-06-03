import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";

interface MediaViewerModalProps {
  items: MediaItem[];
  onClose: () => void;
  startIndex: number;
}

const VIEWER_VOLUME_STORAGE_KEY = "pane-view.viewer.volume";

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

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function MediaViewerModal({
  items,
  onClose,
  startIndex,
}: MediaViewerModalProps): JSX.Element | null {
  const [index, setIndex] = useState(startIndex);
  const item = useMemo(() => items[index], [items, index]);
  const isVideoItem = item?.mediaType === "video";
  const modalRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isScrubbingRef = useRef(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Intentionally reset video state when the active item changes.
  useEffect(() => {
    setPlaying(false);
    setDuration(0);
    setPosition(0);
    setSpeed(1);
  }, [item]);

  const canStepBackward = index > 0;
  const canStepForward = index < items.length - 1;

  const step = useCallback(
    (delta: number) => {
      const nextIndex = Math.max(0, Math.min(items.length - 1, index + delta));
      setIndex(nextIndex);
    },
    [index, items.length],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
      }

      if (!isVideoItem) {
        return;
      }

      if (event.code === "Space") {
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
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVideoItem, onClose, step]);

  if (!item) {
    return null;
  }

  const resolvedDurationMs =
    item.mediaType === "video"
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
    ...(item.width && item.height ? [`${item.width}×${item.height}`] : []),
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

    if ("fastSeek" in video && typeof video.fastSeek === "function") {
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
    <div ref={modalRef} className="fixed inset-0 z-50 bg-zinc-950/95 text-zinc-100">
      {/* Top info bar */}
      <div className="pointer-events-none absolute left-1/2 top-4 z-20 w-[min(94vw,980px)] -translate-x-1/2">
        <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 px-4 py-3 shadow-xl backdrop-blur-xl">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
            <p className="text-xs text-zinc-300">{details.join(" | ")}</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className="rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={() => void toggleFullscreen()}
            >
              Fullscreen
            </button>
            <button
              type="button"
              className="rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Side arrows */}
      <button
        type="button"
        className={`absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-3 text-xl shadow-xl backdrop-blur-xl ${canStepBackward ? "" : "pointer-events-none opacity-40"}`}
        onClick={() => step(-1)}
        disabled={!canStepBackward}
      >
        {"<"}
      </button>
      <button
        type="button"
        className={`absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-3 text-xl shadow-xl backdrop-blur-xl ${canStepForward ? "" : "pointer-events-none opacity-40"}`}
        onClick={() => step(1)}
        disabled={!canStepForward}
      >
        {">"}
      </button>

      {/* Center media */}
      <div className="flex h-full items-center justify-center p-12 pt-24">
        {item.mediaType === "pdf" ? (
          <iframe
            className="h-full w-full border-0"
            src={`/api/media/${item.id}/original`}
            title={item.name}
          />
        ) : item.mediaType === "video" ? (
          <>
            {/* biome-ignore lint/a11y/useMediaCaption: Caption sidecars are not ingested yet. */}
            <video
              key={item.id}
              ref={videoRef}
              className="max-h-full max-w-full rounded bg-black"
              preload="auto"
              playsInline
              onLoadedMetadata={(event) => {
                const loadedDuration = event.currentTarget.duration;
                event.currentTarget.volume = volume;
                event.currentTarget.playbackRate = speed;
                if (Number.isFinite(loadedDuration)) {
                  setDuration(loadedDuration);
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
              onEnded={() => {
                setPlaying(false);
              }}
              src={`/api/media/${item.id}/original`}
            />
          </>
        ) : (
          <img
            src={`/api/media/${item.id}/original`}
            alt={item.name}
            className="max-h-full max-w-full rounded object-contain"
          />
        )}
      </div>

      {/* Video controls */}
      {item.mediaType === "video" ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 w-[min(94vw,980px)] -translate-x-1/2">
          <div className="pointer-events-auto space-y-2 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 px-4 py-3 shadow-xl backdrop-blur-xl">
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
            />
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
              <button
                type="button"
                className="rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={toggleVideoPlayback}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                className="rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={() => skip(-5)}
              >
                -5s
              </button>
              <button
                type="button"
                className="rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={() => skip(5)}
              >
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
                <select
                  className="rounded-xl border border-zinc-300 bg-white/80 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-violet-400 focus:ring-offset-2 dark:border-zinc-700 dark:bg-zinc-900/80"
                  value={speed}
                  onChange={(event) => {
                    applySpeed(Number(event.target.value));
                  }}
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                </select>
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
