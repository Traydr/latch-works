import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { type JSX, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";

const PdfViewer = lazy(() =>
  import("@/features/viewer/PdfViewer").then((module) => ({ default: module.PdfViewer })),
);

interface MediaViewerModalProps {
  autoplayVideos: boolean;
  items: MediaItem[];
  loopNavigation: boolean;
  loopVideos: boolean;
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
  autoplayVideos,
  items,
  loopNavigation,
  loopVideos,
  onClose,
  startIndex,
}: MediaViewerModalProps): JSX.Element | null {
  const isMobile = useIsMobile();
  const [index, setIndex] = useState(startIndex);
  const item = useMemo(() => items[index], [items, index]);
  const isVideoItem = item?.mediaType === "video";
  const modalRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const isScrubbingRef = useRef(false);
  const speedBoostHeldRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(() => readPersistedVolume());
  const [speed, setSpeed] = useState(1);
  const [showOriginal, setShowOriginal] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);

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
    setSpeed(1);
    setShowOriginal(false);
    speedBoostHeldRef.current = false;
  }, [item]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const prefetch = (targetIndex: number) => {
      const target = items[targetIndex];
      if (!target || target.mediaType === "video" || target.mediaType === "pdf") {
        return;
      }

      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = `/api/media/${target.id}/preview`;
      document.head.append(link);
    };

    prefetch(index + 1);
    prefetch(index - 1);
  }, [index, items]);

  const step = useCallback(
    (delta: number) => {
      setIndex((currentIndex) => {
        if (items.length === 0) {
          return 0;
        }

        const nextIndex = loopNavigation
          ? (currentIndex + delta + items.length) % items.length
          : Math.max(0, Math.min(items.length - 1, currentIndex + delta));

        return nextIndex;
      });
    },
    [items.length, loopNavigation],
  );

  const skip = useCallback((seconds: number): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const total = video.duration;
    if (!Number.isFinite(total) || total <= 0) {
      return;
    }

    const nextTime = video.currentTime + seconds;
    const safeTotal = Math.max(0, total - 0.05);
    const clamped = Math.max(0, Math.min(safeTotal, nextTime));
    const wasPlaying = !video.paused;

    video.currentTime = clamped;
    setPosition(clamped);

    if (wasPlaying) {
      void video.play().catch(() => {
        // Keep paused if resume cannot start.
      });
    }
  }, []);

  // Keyboard handling.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

      if (key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (key === "ArrowRight" || key === "e") {
        event.preventDefault();
        step(1);
        return;
      }
      if (key === "ArrowLeft" || key === "q") {
        event.preventDefault();
        step(-1);
        return;
      }

      if (!isVideoItem) {
        return;
      }

      if (key === " " || key === "2") {
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
      if (key === "1") {
        event.preventDefault();
        skip(-5);
        return;
      }
      if (key === "3") {
        event.preventDefault();
        skip(5);
        return;
      }
      if (key === "4") {
        event.preventDefault();
        speedBoostHeldRef.current = true;
        applySpeed(2);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "4" && speedBoostHeldRef.current) {
        speedBoostHeldRef.current = false;
        applySpeed(1);
      }
    };

    const resetHeldSpeed = () => {
      if (speedBoostHeldRef.current) {
        speedBoostHeldRef.current = false;
        applySpeed(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", resetHeldSpeed);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", resetHeldSpeed);
    };
  }, [applySpeed, isVideoItem, onClose, skip, step]);

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

  const canStepBackward = loopNavigation || index > 0;
  const canStepForward = loopNavigation || index < items.length - 1;

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(item.path);
  };

  const downloadMedia = (): void => {
    window.open(`/api/media/${item.id}/original`, "_blank", "noopener,noreferrer");
  };

  const imageSrc =
    showOriginal || item.mediaType !== "image"
      ? `/api/media/${item.id}/original`
      : `/api/media/${item.id}/preview`;

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-50 bg-zinc-950/95 text-zinc-100"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewer for ${item.name}`}
      onClick={() => {
        if (isMobile) {
          setChromeVisible((visible) => !visible);
        }
      }}
    >
      {/* Top info bar */}
      <div
        className={`pointer-events-none absolute left-1/2 top-4 z-20 w-[min(94vw,980px)] -translate-x-1/2 transition-opacity ${chromeVisible ? "opacity-100" : "opacity-0 md:opacity-100"}`}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-2xl border border-zinc-700/80 bg-zinc-900/90 px-4 py-3 shadow-xl backdrop-blur-xl">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
            <p className={`text-xs text-zinc-300 ${isMobile ? "truncate" : ""}`}>{details.join(" | ")}</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={(event) => {
                event.stopPropagation();
                void copyPath();
              }}
            >
              Copy path
            </button>
            <button
              type="button"
              className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={(event) => {
                event.stopPropagation();
                downloadMedia();
              }}
            >
              Download
            </button>
            {item.mediaType === "image" ? (
              <button
                type="button"
                className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowOriginal((current) => !current);
                }}
              >
                {showOriginal ? "Preview" : "Original"}
              </button>
            ) : null}
            <button
              type="button"
              className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={(event) => {
                event.stopPropagation();
                void toggleFullscreen();
              }}
            >
              Fullscreen
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close viewer"
              className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label="Previous item"
        className={`absolute left-0 top-0 z-10 h-full w-1/2 ${canStepBackward ? "cursor-w-resize" : "cursor-default"} md:hidden`}
        onClick={(event) => {
          event.stopPropagation();
          if (canStepBackward) {
            step(-1);
          }
        }}
      />
      <button
        type="button"
        aria-label="Next item"
        className={`absolute right-0 top-0 z-10 h-full w-1/2 ${canStepForward ? "cursor-e-resize" : "cursor-default"} md:hidden`}
        onClick={(event) => {
          event.stopPropagation();
          if (canStepForward) {
            step(1);
          }
        }}
      />

      {/* Side arrows */}
      <button
        type="button"
        aria-label="Previous item"
        className={`absolute left-4 top-1/2 z-20 hidden -translate-y-1/2 cursor-pointer rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-3 text-xl shadow-xl backdrop-blur-xl md:block ${canStepBackward ? "" : "pointer-events-none opacity-40"}`}
        onClick={(event) => {
          event.stopPropagation();
          step(-1);
        }}
        disabled={!canStepBackward}
      >
        {"<"}
      </button>
      <button
        type="button"
        aria-label="Next item"
        className={`absolute right-4 top-1/2 z-20 hidden -translate-y-1/2 cursor-pointer rounded-2xl border border-zinc-700/80 bg-zinc-900/90 p-3 text-xl shadow-xl backdrop-blur-xl md:block ${canStepForward ? "" : "pointer-events-none opacity-40"}`}
        onClick={(event) => {
          event.stopPropagation();
          step(1);
        }}
        disabled={!canStepForward}
      >
        {">"}
      </button>

      {/* Center media */}
      <div
        className="flex h-full items-center justify-center px-3 pb-[env(safe-area-inset-bottom)] pt-[calc(env(safe-area-inset-top)+5rem)] md:p-12 md:pt-24"
        onClick={(event) => event.stopPropagation()}
      >
        {item.mediaType === "pdf" ? (
          <Suspense fallback={<p className="text-sm text-zinc-400">Loading PDF…</p>}>
            <PdfViewer mediaId={item.id} title={item.name} />
          </Suspense>
        ) : item.mediaType === "video" ? (
          <>
            {/* biome-ignore lint/a11y/useMediaCaption: Caption sidecars are not ingested yet. */}
            <video
              key={item.id}
              ref={videoRef}
              className="max-h-full max-w-full rounded bg-black"
              preload="auto"
              playsInline
              autoPlay={autoplayVideos}
              loop={loopVideos}
              onLoadedMetadata={(event) => {
                const loadedDuration = event.currentTarget.duration;
                event.currentTarget.volume = volume;
                event.currentTarget.playbackRate = speed;
                if (Number.isFinite(loadedDuration)) {
                  setDuration(loadedDuration);
                }
                if (autoplayVideos) {
                  void event.currentTarget.play().catch(() => undefined);
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
            src={imageSrc}
            alt={item.name}
            className="max-h-full max-w-full rounded object-contain"
          />
        )}
      </div>

      {/* Video controls */}
      {item.mediaType === "video" ? (
        <div
          className={`pointer-events-none absolute bottom-4 left-1/2 z-20 w-[min(94vw,980px)] -translate-x-1/2 transition-opacity ${chromeVisible ? "opacity-100" : "opacity-0 md:opacity-100"}`}
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
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
                className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={toggleVideoPlayback}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
                onClick={() => skip(-5)}
              >
                -5s
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-xl border border-zinc-300/90 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-200"
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

function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT")
  );
}
