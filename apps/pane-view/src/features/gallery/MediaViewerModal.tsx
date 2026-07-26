import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { Copy, Download, Image, type LucideIcon, Maximize, Pause, Play, X } from "lucide-react";
import {
  forwardRef,
  type JSX,
  lazy,
  type MouseEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLibraryViewerState } from "@/features/viewer/use-library-viewer-state";
import {
  resolveVideoResumeSeconds,
  videoSecondsToPositionMs,
} from "@/features/viewer/viewer-resume";
import { useIsMobile } from "@/hooks/use-mobile";
import { useViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { GALLERY_PREVIEW_SIZE } from "./gallery-preview-size";
import { PaneViewImage } from "./PaneViewImage";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

const PdfViewer = lazy(() =>
  import("@/features/viewer/PdfViewer").then((module) => ({ default: module.PdfViewer })),
);

interface MediaViewerModalProps {
  autoplayVideos: boolean;
  items: MediaItem[];
  loopNavigation: boolean;
  loopVideos: boolean;
  onClose: () => void;
  rememberViewerPosition: boolean;
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
  rememberViewerPosition,
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
  const hasRestoredVideoRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(() => readPersistedVolume());
  const [speed, setSpeed] = useState(1);
  const [showOriginal, setShowOriginal] = useState(false);
  const chromePinned = isVideoItem && !playing;
  const { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass } = useViewerChromeIdle({
    isMobile,
    pinned: chromePinned,
  });
  const videoDelivery = useResolvedMediaUrl({
    mediaId: item?.mediaType === "video" ? item.id : undefined,
    variant: "original",
  });
  const viewerStateSubjectId =
    rememberViewerPosition && item && (item.mediaType === "video" || item.mediaType === "pdf")
      ? item.id
      : undefined;
  const {
    flushSave,
    scheduleSave,
    snapshot: viewerState,
  } = useLibraryViewerState(viewerStateSubjectId);
  const [resumePdfPage, setResumePdfPage] = useState<number | undefined>();

  useEffect(() => {
    setResumePdfPage(undefined);
  }, [item?.id]);

  useEffect(() => {
    if (viewerState?.page !== undefined) {
      setResumePdfPage((current) => current ?? viewerState.page);
    }
  }, [viewerState?.page]);

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
    hasRestoredVideoRef.current = false;
  }, [item]);

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  useEffect(() => {
    if (item?.mediaType !== "video" || hasRestoredVideoRef.current) {
      return;
    }

    const video = videoRef.current;
    if (!video) {
      return;
    }

    const loadedDuration = video.duration;
    if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) {
      return;
    }

    const resumeSeconds = resolveVideoResumeSeconds(viewerState?.positionMs, loadedDuration);
    if (resumeSeconds === null) {
      return;
    }

    video.currentTime = resumeSeconds;
    setPosition(resumeSeconds);
    hasRestoredVideoRef.current = true;
  }, [item?.id, item?.mediaType, viewerState?.positionMs]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

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
      revealChrome();

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
  }, [applySpeed, isVideoItem, onClose, revealChrome, skip, step]);

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

  return (
    <div
      ref={modalRef}
      className={`fixed inset-0 z-50 bg-zinc-950/95 text-zinc-100 ${!isMobile && !chromeVisible ? "cursor-none" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewer for ${item.name}`}
      onClick={() => {
        toggleChrome();
      }}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      {/* Top info bar */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-8 pt-3 transition-opacity duration-300 ${chromeVisibilityClass}`}
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="pointer-events-auto flex items-center justify-between gap-2 sm:gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{item.name}</p>
            <p className="truncate text-xs text-white/70">{details.join(" · ")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <ViewerToolbarButton
              ariaLabel="Copy path"
              icon={Copy}
              label="Copy path"
              onClick={(event) => {
                event.stopPropagation();
                void copyPath();
              }}
            />
            <ViewerToolbarButton
              ariaLabel="Download"
              icon={Download}
              label="Download"
              onClick={(event) => {
                event.stopPropagation();
                downloadMedia();
              }}
            />
            {item.mediaType === "image" ? (
              <ViewerToolbarButton
                ariaLabel={showOriginal ? "Show preview" : "Show original"}
                icon={Image}
                label={showOriginal ? "Preview" : "Original"}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowOriginal((current) => !current);
                }}
              />
            ) : null}
            <ViewerToolbarButton
              ariaLabel="Toggle fullscreen"
              icon={Maximize}
              label="Fullscreen"
              onClick={(event) => {
                event.stopPropagation();
                void toggleFullscreen();
              }}
            />
            <ViewerToolbarButton
              ref={closeButtonRef}
              ariaLabel="Close viewer"
              icon={X}
              label="Close"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
          </div>
        </div>
      </div>

      {item.mediaType !== "pdf" ? (
        <>
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
        </>
      ) : null}

      {/* Side arrows */}
      <button
        type="button"
        aria-label="Previous item"
        className={`absolute left-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chromeVisibilityClass} ${canStepBackward ? "" : "pointer-events-none opacity-40"}`}
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
        className={`absolute right-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chromeVisibilityClass} ${canStepForward ? "" : "pointer-events-none opacity-40"}`}
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
        className="flex h-full items-center justify-center p-3 pb-[env(safe-area-inset-bottom)]"
        onClick={(event) => event.stopPropagation()}
      >
        {item.mediaType === "pdf" ? (
          <Suspense fallback={<p className="text-sm text-zinc-400">Loading PDF…</p>}>
            <PdfViewer
              initialPage={resumePdfPage}
              mediaId={item.id}
              onPageChange={(page) => {
                scheduleSave({ page });
              }}
              title={item.name}
            />
          </Suspense>
        ) : item.mediaType === "video" ? (
          <>
            {/* biome-ignore lint/a11y/useMediaCaption: Caption sidecars are not ingested yet. */}
            <video
              key={item.id}
              ref={videoRef}
              className="max-h-full max-w-full bg-black object-contain"
              preload="auto"
              playsInline
              autoPlay={autoplayVideos}
              loop={loopVideos}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const loadedDuration = video.duration;
                video.volume = volume;
                video.playbackRate = speed;
                if (Number.isFinite(loadedDuration)) {
                  setDuration(loadedDuration);
                }

                if (!hasRestoredVideoRef.current) {
                  const resumeSeconds = resolveVideoResumeSeconds(
                    viewerState?.positionMs,
                    loadedDuration,
                  );
                  if (resumeSeconds !== null) {
                    video.currentTime = resumeSeconds;
                    setPosition(resumeSeconds);
                    hasRestoredVideoRef.current = true;
                  }
                }

                if (autoplayVideos) {
                  void video.play().catch(() => undefined);
                }
              }}
              onDurationChange={(event) => {
                const nextDuration = event.currentTarget.duration;
                if (Number.isFinite(nextDuration)) {
                  setDuration(nextDuration);
                }
              }}
              onTimeUpdate={(event) => {
                if (isScrubbingRef.current) {
                  return;
                }

                const currentTime = event.currentTarget.currentTime || 0;
                setPosition(currentTime);
                scheduleSave({
                  positionMs: videoSecondsToPositionMs(currentTime),
                });
              }}
              onPlay={() => setPlaying(true)}
              onPause={(event) => {
                setPlaying(false);
                if (!isScrubbingRef.current) {
                  scheduleSave({
                    positionMs: videoSecondsToPositionMs(event.currentTarget.currentTime || 0),
                  });
                  void flushSave();
                }
              }}
              onEnded={() => {
                setPlaying(false);
              }}
              src={videoDelivery.resolvedUrl ?? undefined}
            />
          </>
        ) : (
          <PaneViewImage
            alt={item.name}
            className="max-h-full max-w-full object-contain"
            layout="fullWidth"
            mediaId={item.id}
            objectFit="contain"
            variant={showOriginal || item.mediaType !== "image" ? "original" : "preview"}
            width={GALLERY_PREVIEW_SIZE}
          />
        )}
      </div>

      {/* Video controls */}
      {item.mediaType === "video" ? (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-4 pb-4 pt-10 transition-opacity duration-300 ${chromeVisibilityClass}`}
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <div className="pointer-events-auto space-y-2">
            <input
              type="range"
              min={0}
              max={canSeek ? duration : 1}
              step={0.1}
              value={position}
              className="w-full accent-violet-400"
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
                scheduleSave({
                  positionMs: videoSecondsToPositionMs(next),
                });
                void flushSave();
              }}
              onInput={(event) => {
                const next = Number((event.currentTarget as HTMLInputElement).value);
                setPosition(next);
              }}
            />
            <div className="flex flex-wrap items-center gap-2 text-sm text-white/90">
              <button
                type="button"
                className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
                title={playing ? "Pause" : "Play"}
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggleVideoPlayback}
              >
                {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
              </button>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
                onClick={() => skip(-5)}
              >
                -5s
              </button>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
                onClick={() => skip(5)}
              >
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
                  className="accent-violet-400"
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
                    applySpeed(Number(event.target.value));
                  }}
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                </select>
              </label>
              <span className="tabular-nums text-white/70">
                {Math.floor(position)}/{Math.floor(duration || 0)}s
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ViewerToolbarButton = forwardRef<
  HTMLButtonElement,
  {
    ariaLabel: string;
    icon: LucideIcon;
    label: string;
    onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  }
>(function ViewerToolbarButton({ ariaLabel, icon: Icon, label, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      title={label}
      className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
      onClick={onClick}
    >
      <Icon className="size-4" />
      <span className="sr-only">{label}</span>
    </button>
  );
});

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
