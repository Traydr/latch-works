import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { Copy, Download, Image, type LucideIcon, Maximize, Pause, Play, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  type JSX,
  lazy,
  type MouseEvent,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
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

export interface MediaViewerSessionProps {
  autoplayVideos: boolean;
  canStepBackward: boolean;
  canStepForward: boolean;
  item: MediaItem;
  loopVideos: boolean;
  onClose: () => void;
  onStep: (delta: -1 | 1) => void;
  rememberViewerPosition: boolean;
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

function useMediaViewerSession({
  autoplayVideos,
  canStepBackward,
  canStepForward,
  item,
  loopVideos,
  onClose,
  onStep,
  rememberViewerPosition,
}: MediaViewerSessionProps) {
  const isMobile = useIsMobile();
  const isVideoItem = item.mediaType === "video";
  const modalRef = useRef<HTMLDialogElement | null>(null);
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
    mediaId: item.mediaType === "video" ? item.id : undefined,
    variant: "original",
  });
  const viewerStateSubjectId =
    rememberViewerPosition && (item.mediaType === "video" || item.mediaType === "pdf")
      ? item.id
      : undefined;
  const {
    flushSave,
    scheduleSave,
    snapshot: viewerState,
  } = useLibraryViewerState(viewerStateSubjectId);
  const [resumePdfPage, setResumePdfPage] = useState<number | undefined>();

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
    const dialog = modalRef.current;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.setAttribute("open", "");
      }
    }
    closeButtonRef.current?.focus();

    return () => {
      if (dialog) {
        if (typeof dialog.close === "function") {
          dialog.close();
        } else {
          dialog.removeAttribute("open");
        }
      }
      previousFocusRef.current?.focus();
    };
  }, []);

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

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
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
      onStep(1);
      return;
    }
    if (key === "ArrowLeft" || key === "q") {
      event.preventDefault();
      onStep(-1);
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
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === "4" && speedBoostHeldRef.current) {
      speedBoostHeldRef.current = false;
      applySpeed(1);
    }
  });

  const resetHeldSpeed = useEffectEvent(() => {
    if (speedBoostHeldRef.current) {
      speedBoostHeldRef.current = false;
      applySpeed(1);
    }
  });

  // Keyboard handling.
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", resetHeldSpeed);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", resetHeldSpeed);
    };
  }, []);

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

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(item.path);
  };

  const downloadMedia = (): void => {
    window.open(`/api/media/${item.id}/original`, "_blank", "noopener,noreferrer");
  };

  return {
    applySpeed,
    autoplayVideos,
    canSeek,
    canStepBackward,
    canStepForward,
    chromeVisibilityClass,
    chromeVisible,
    closeButtonRef,
    commitSeek,
    copyPath,
    details,
    downloadMedia,
    duration,
    flushSave,
    hasRestoredVideoRef,
    isMobile,
    isScrubbingRef,
    item,
    loopVideos,
    modalRef,
    onClose,
    onStep,
    playing,
    position,
    resumePdfPage,
    revealChrome,
    scheduleSave,
    setDuration,
    setPlaying,
    setPosition,
    setShowOriginal,
    setVolume,
    showOriginal,
    skip,
    speed,
    toggleChrome,
    toggleFullscreen,
    toggleVideoPlayback,
    videoDelivery,
    videoRef,
    viewerState,
    volume,
  };
}

type MediaViewerSessionModel = ReturnType<typeof useMediaViewerSession>;
const MediaViewerSessionContext = createContext<MediaViewerSessionModel | null>(null);

function useMediaViewerSessionModel(): MediaViewerSessionModel {
  const model = useContext(MediaViewerSessionContext);
  if (!model) {
    throw new Error("Media viewer session context is missing");
  }
  return model;
}

export function MediaViewerSession(props: MediaViewerSessionProps): JSX.Element {
  const model = useMediaViewerSession(props);
  return (
    <MediaViewerSessionContext.Provider value={model}>
      <ViewerDialog />
    </MediaViewerSessionContext.Provider>
  );
}

function ViewerDialog(): JSX.Element {
  const { chromeVisible, isMobile, item, modalRef, onClose, revealChrome, toggleChrome } =
    useMediaViewerSessionModel();
  return (
    // The dialog is the correct modal primitive; pointer handlers only manage transient chrome.
    // react-doctor-disable-next-line react-doctor/no-noninteractive-element-interactions
    <dialog
      ref={modalRef}
      className={`fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-zinc-950/95 p-0 text-zinc-100 ${!isMobile && !chromeVisible ? "cursor-none" : ""}`}
      aria-label={`Viewer for ${item.name}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={toggleChrome}
      onMouseMove={revealChrome}
      onPointerDown={revealChrome}
    >
      <ViewerTopBar />
      <ViewerNavigation />
      <ViewerMedia />
      <ViewerVideoControls />
    </dialog>
  );
}

function ViewerTopBar(): JSX.Element {
  const {
    chromeVisibilityClass,
    closeButtonRef,
    copyPath,
    details,
    downloadMedia,
    item,
    onClose,
    setShowOriginal,
    showOriginal,
    toggleFullscreen,
  } = useMediaViewerSessionModel();
  return (
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
            onClick={() => void copyPath()}
          />
          <ViewerToolbarButton
            ariaLabel="Download"
            icon={Download}
            label="Download"
            onClick={downloadMedia}
          />
          {item.mediaType === "image" ? (
            <ViewerToolbarButton
              ariaLabel={showOriginal ? "Show preview" : "Show original"}
              icon={Image}
              label={showOriginal ? "Preview" : "Original"}
              onClick={() => setShowOriginal((current) => !current)}
            />
          ) : null}
          <ViewerToolbarButton
            ariaLabel="Toggle fullscreen"
            icon={Maximize}
            label="Fullscreen"
            onClick={() => void toggleFullscreen()}
          />
          <ViewerToolbarButton
            ref={closeButtonRef}
            ariaLabel="Close viewer"
            icon={X}
            label="Close"
            onClick={onClose}
          />
        </div>
      </div>
    </div>
  );
}

function ViewerNavigation(): JSX.Element {
  const { canStepBackward, canStepForward, chromeVisibilityClass, item, onStep } =
    useMediaViewerSessionModel();
  return (
    <>
      {item.mediaType !== "pdf" ? (
        <>
          <button
            type="button"
            aria-label="Previous item"
            className={`absolute left-0 top-0 z-10 h-full w-1/2 ${canStepBackward ? "cursor-w-resize" : "cursor-default"} md:hidden`}
            onClick={() => canStepBackward && onStep(-1)}
          />
          <button
            type="button"
            aria-label="Next item"
            className={`absolute right-0 top-0 z-10 h-full w-1/2 ${canStepForward ? "cursor-e-resize" : "cursor-default"} md:hidden`}
            onClick={() => canStepForward && onStep(1)}
          />
        </>
      ) : null}
      <button
        type="button"
        aria-label="Previous item"
        className={`absolute left-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chromeVisibilityClass} ${canStepBackward ? "" : "pointer-events-none opacity-40"}`}
        onClick={() => onStep(-1)}
        disabled={!canStepBackward}
      >
        {"<"}
      </button>
      <button
        type="button"
        aria-label="Next item"
        className={`absolute right-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chromeVisibilityClass} ${canStepForward ? "" : "pointer-events-none opacity-40"}`}
        onClick={() => onStep(1)}
        disabled={!canStepForward}
      >
        {">"}
      </button>
    </>
  );
}

function ViewerMedia(): JSX.Element {
  const model = useMediaViewerSessionModel();
  const { item } = model;
  return (
    <div
      className="flex h-full items-center justify-center p-3 pb-[env(safe-area-inset-bottom)]"
      onClick={(event) => event.stopPropagation()}
    >
      {item.mediaType === "pdf" ? (
        <ViewerPdf model={model} />
      ) : item.mediaType === "video" ? (
        <ViewerVideo model={model} />
      ) : (
        <PaneViewImage
          alt={item.name}
          className="max-h-full max-w-full object-contain"
          layout="fullWidth"
          mediaId={item.id}
          objectFit="contain"
          variant={model.showOriginal || item.mediaType !== "image" ? "original" : "preview"}
          width={GALLERY_PREVIEW_SIZE}
        />
      )}
    </div>
  );
}

function ViewerPdf({ model }: { model: MediaViewerSessionModel }): JSX.Element {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">Loading PDF…</p>}>
      <PdfViewer
        initialPage={model.resumePdfPage}
        mediaId={model.item.id}
        onPageChange={(page) => model.scheduleSave({ page })}
        title={model.item.name}
      />
    </Suspense>
  );
}

function ViewerVideo({ model }: { model: MediaViewerSessionModel }): JSX.Element {
  return (
    // biome-ignore lint/a11y/useMediaCaption: Caption sidecars are not ingested yet.
    <video
      ref={model.videoRef}
      className="max-h-full max-w-full bg-black object-contain"
      preload="auto"
      playsInline
      autoPlay={model.autoplayVideos}
      loop={model.loopVideos}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        const loadedDuration = video.duration;
        video.volume = model.volume;
        video.playbackRate = model.speed;
        if (Number.isFinite(loadedDuration)) model.setDuration(loadedDuration);
        if (!model.hasRestoredVideoRef.current) {
          const resumeSeconds = resolveVideoResumeSeconds(
            model.viewerState?.positionMs,
            loadedDuration,
          );
          if (resumeSeconds !== null) {
            video.currentTime = resumeSeconds;
            model.setPosition(resumeSeconds);
            model.hasRestoredVideoRef.current = true;
          }
        }
        if (model.autoplayVideos) void video.play().catch(() => undefined);
      }}
      onDurationChange={(event) => {
        if (Number.isFinite(event.currentTarget.duration))
          model.setDuration(event.currentTarget.duration);
      }}
      onTimeUpdate={(event) => {
        if (model.isScrubbingRef.current) return;
        const currentTime = event.currentTarget.currentTime || 0;
        model.setPosition(currentTime);
        model.scheduleSave({ positionMs: videoSecondsToPositionMs(currentTime) });
      }}
      onPlay={() => model.setPlaying(true)}
      onPause={(event) => {
        model.setPlaying(false);
        if (!model.isScrubbingRef.current) {
          model.scheduleSave({
            positionMs: videoSecondsToPositionMs(event.currentTarget.currentTime || 0),
          });
          void model.flushSave();
        }
      }}
      onEnded={() => model.setPlaying(false)}
      src={model.videoDelivery.resolvedUrl ?? undefined}
    />
  );
}

function ViewerVideoControls(): JSX.Element | null {
  const model = useMediaViewerSessionModel();
  if (model.item.mediaType !== "video") return null;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-4 pb-4 pt-10 transition-opacity duration-300 ${model.chromeVisibilityClass}`}
      style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-auto space-y-2">
        <input
          aria-label="Video seek position"
          type="range"
          min={0}
          max={model.canSeek ? model.duration : 1}
          step={0.1}
          value={model.position}
          className="w-full accent-violet-400"
          disabled={!model.canSeek}
          onPointerDown={() => {
            model.isScrubbingRef.current = true;
          }}
          onPointerUp={(event) => {
            if (!model.canSeek) {
              model.isScrubbingRef.current = false;
              return;
            }
            const next = Number(event.currentTarget.value);
            model.commitSeek(next);
            model.isScrubbingRef.current = false;
            model.scheduleSave({ positionMs: videoSecondsToPositionMs(next) });
            void model.flushSave();
          }}
          onInput={(event) => model.setPosition(Number(event.currentTarget.value))}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm text-white/90">
          <button
            type="button"
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
            title={model.playing ? "Pause" : "Play"}
            aria-label={model.playing ? "Pause" : "Play"}
            onClick={model.toggleVideoPlayback}
          >
            {model.playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
            onClick={() => model.skip(-5)}
          >
            -5s
          </button>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium text-white/90 transition hover:bg-violet-500/25 hover:text-violet-100"
            onClick={() => model.skip(5)}
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
              value={model.volume}
              className="accent-violet-400"
              onChange={(event) => {
                const clamped = Math.max(0, Math.min(1, Number(event.target.value)));
                model.setVolume(clamped);
                try {
                  window.localStorage.setItem(VIEWER_VOLUME_STORAGE_KEY, String(clamped));
                } catch {
                  /* Ignore storage write errors. */
                }
                if (model.videoRef.current) model.videoRef.current.volume = clamped;
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-white/80">
            Speed
            <select
              className="rounded-lg border-0 bg-white/15 px-2 py-1 text-xs text-white outline-none"
              value={model.speed}
              onChange={(event) => model.applySpeed(Number(event.target.value))}
            >
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
            </select>
          </label>
          <span className="tabular-nums text-white/70">
            {Math.floor(model.position)}/{Math.floor(model.duration || 0)}s
          </span>
        </div>
      </div>
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
