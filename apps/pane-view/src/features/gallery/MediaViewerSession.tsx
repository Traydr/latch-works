import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import {
  Copy,
  Download,
  Image,
  type LucideIcon,
  Maximize,
  Minimize,
  VideoOff,
  X,
} from "lucide-react";
import {
  createContext,
  forwardRef,
  type JSX,
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useLibraryViewerState,
  type ViewerStateStore,
} from "@/features/viewer/use-library-viewer-state";
import { VIDEO_SKIP_SECONDS } from "@/features/viewer/video-playback";
import {
  resolveVideoResumeSeconds,
  videoSecondsToPositionMs,
} from "@/features/viewer/viewer-resume";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useIsMobile } from "@/hooks/use-mobile";
import { useViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { isTextInputTarget } from "./browse-search";
import { GALLERY_PREVIEW_SIZE } from "./gallery-preview-size";
import { PaneViewImage } from "./PaneViewImage";
import { type ResolvedMediaUrlCache, useResolvedMediaUrl } from "./useResolvedMediaUrl";
import { createPlaybackPosition } from "./video-player/playback-position";
import { VideoPlayerChrome } from "./video-player/VideoPlayerChrome";
import { ChromeRegion, useHoldToBoost } from "./video-player/video-player-controls";

const PdfViewer = lazy(() =>
  import("@/features/viewer/PdfViewer").then((module) => ({ default: module.PdfViewer })),
);

export interface MediaViewerSessionProps {
  autoplayVideos: boolean;
  /** Overrides the shared URL cache; tests inject a cache with a fake resolver. */
  cache?: ResolvedMediaUrlCache;
  canStepBackward: boolean;
  canStepForward: boolean;
  item: MediaItem;
  loopVideos: boolean;
  onClose: () => void;
  onStep: (delta: -1 | 1) => void;
  rememberViewerPosition: boolean;
  /** Overrides the viewer-state server calls; tests inject an in-memory store. */
  viewerStateStore?: ViewerStateStore;
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

/** The viewer's name for a key press, or null when the press belongs to a text field or a chord. */
function viewerKey(event: KeyboardEvent): string | null {
  if (isTextInputTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }

  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

/** The gallery tile for `mediaId`, when the grid has it rendered. */
function renderedMediaTile(mediaId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-browser-entry="media:${CSS.escape(mediaId)}"]`);
}

/** What the shared chrome needs from the current video; the item's session reports it. */
interface VideoStatus {
  duration: number;
  mediaId: string;
  playing: boolean;
}

/**
 * The part of the viewer that outlives a step: the dialog (and the fullscreen
 * it may hold), the idle chrome, the title bar and prev/next. Only the media
 * and its playback state remount per item.
 */
function useViewerShell({
  canStepBackward,
  canStepForward,
  item,
  onClose,
  onStep,
}: MediaViewerSessionProps) {
  const isMobile = useIsMobile();
  const isCoarsePointer = useCoarsePointer();
  const isVideoItem = item.mediaType === "video";
  const modalRef = useRef<HTMLDialogElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const itemIdRef = useRef(item.id);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoStatus, setVideoStatus] = useState<VideoStatus | null>(null);
  const [originalShownFor, setOriginalShownFor] = useState<string | null>(null);
  // Tagged with the media id, so a step starts the next item paused and unmeasured.
  const currentVideo = videoStatus?.mediaId === item.id ? videoStatus : null;
  const playing = currentVideo?.playing ?? false;
  const duration = currentVideo?.duration ?? 0;
  const showOriginal = originalShownFor === item.id;
  // Video chrome pins while paused and idles away during playback on every device;
  // other media keep the old rule (idle on desktop, tap to toggle on mobile).
  const chromePinned = isVideoItem && !playing;

  const { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass } = useViewerChromeIdle({
    idleOnMobile: isVideoItem,
    isMobile,
    pinned: chromePinned,
  });

  const revealForItem = useEffectEvent(() => revealChrome());

  useEffect(() => {
    itemIdRef.current = item.id;
    // Each item arrives with the chrome showing, as when every step remounted the viewer;
    // a phone's step zone also toggles the chrome, which would otherwise hide it every other step.
    revealForItem();
  }, [item.id]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(fullscreenElementOf(document) !== null);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  // Opened before paint so the gallery never shows through for a frame.
  useLayoutEffect(() => {
    const dialog = modalRef.current;
    const active = document.activeElement;
    const openedFrom = active instanceof HTMLElement ? active : null;

    if (dialog && !dialog.open) {
      openDialog(dialog);
    }

    closeButtonRef.current?.focus();

    return () => {
      if (dialog) {
        closeDialog(dialog);
      }

      // Back to the tile of the item on screen at close, else where the viewer opened from.
      (renderedMediaTile(itemIdRef.current) ?? openedFrom)?.focus();
    };
  }, []);

  const reportVideo = useCallback(
    (mediaId: string, patch: Partial<Pick<VideoStatus, "duration" | "playing">>): void => {
      setVideoStatus((current) => {
        const base =
          current?.mediaId === mediaId ? current : { duration: 0, mediaId, playing: false };

        return { ...base, ...patch };
      });
    },
    [],
  );

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    revealChrome();

    const key = viewerKey(event);

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
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
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

  const toggleFullscreen = async (): Promise<void> => {
    const dialog = modalRef.current;

    if (!dialog) {
      return;
    }

    const doc: WebkitFullscreenDocument = document;

    if (fullscreenElementOf(document)) {
      if (doc.exitFullscreen) await document.exitFullscreen();
      else await doc.webkitExitFullscreen?.();

      return;
    }

    // Element fullscreen where the browser allows it (Safari keeps the prefixed
    // form; iPhone Safari has none, and iPad Safari can refuse it for a modal
    // dialog). When it is unavailable or refused, the video itself can still go
    // full screen with its native player.
    const host: FullscreenHost = dialog;

    try {
      if (doc.fullscreenEnabled !== false && host.requestFullscreen) {
        await dialog.requestFullscreen();

        return;
      }

      if (host.webkitRequestFullscreen) {
        await host.webkitRequestFullscreen();

        return;
      }
    } catch {
      // Fall through to the video's own fullscreen.
    }

    const video: WebkitFullscreenVideo | null = videoRef.current;
    video?.webkitEnterFullscreen?.();
  };

  const toggleOriginal = (): void => {
    setOriginalShownFor((current) => (current === item.id ? null : item.id));
  };

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(item.path);
  };

  const downloadMedia = (): void => {
    window.open(`/api/media/${item.id}/original`, "_blank", "noopener,noreferrer");
  };

  return {
    canStepBackward,
    canStepForward,
    chromeVisibilityClass,
    chromeVisible,
    closeButtonRef,
    copyPath,
    details,
    downloadMedia,
    duration,
    isCoarsePointer,
    isFullscreen,
    isMobile,
    item,
    modalRef,
    onClose,
    onStep,
    playing,
    reportVideo,
    revealChrome,
    showOriginal,
    toggleChrome,
    toggleFullscreen,
    toggleOriginal,
    videoRef,
  };
}

type ViewerShellModel = ReturnType<typeof useViewerShell>;

const ViewerShellContext = createContext<ViewerShellModel | null>(null);

function useViewerShellModel(): ViewerShellModel {
  const shell = useContext(ViewerShellContext);

  if (!shell) {
    throw new Error("Media viewer shell context is missing");
  }

  return shell;
}

/** Media and playback state for one item; remounts on every step. */
function useMediaViewerSession({
  autoplayVideos,
  cache,
  item,
  loopVideos,
  rememberViewerPosition,
  viewerStateStore,
}: MediaViewerSessionProps) {
  const shell = useViewerShellModel();
  const { duration, playing, reportVideo, videoRef } = shell;
  const isVideoItem = item.mediaType === "video";
  const isScrubbingRef = useRef(false);
  const holdBoostActiveRef = useRef(false);
  const speedBeforeHoldRef = useRef(1);
  const hasRestoredVideoRef = useRef(false);

  const [playbackPosition] = useState(createPlaybackPosition);
  const [volume, setVolume] = useState(() => readPersistedVolume());
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [holdBoosting, setHoldBoosting] = useState(false);

  const setPlaying = useCallback(
    (nextPlaying: boolean): void => reportVideo(item.id, { playing: nextPlaying }),
    [item.id, reportVideo],
  );

  const setDuration = useCallback(
    (nextDuration: number): void => reportVideo(item.id, { duration: nextDuration }),
    [item.id, reportVideo],
  );

  const [videoRefreshKey, setVideoRefreshKey] = useState(0);
  const [videoLoadFailed, setVideoLoadFailed] = useState(false);

  const videoDelivery = useResolvedMediaUrl({
    cache,
    mediaId: item.mediaType === "video" ? item.id : undefined,
    refreshKey: videoRefreshKey,
    variant: "original",
  });

  const videoFailed = videoDelivery.failed || videoLoadFailed;

  /** The cached URL may have expired: resolve a fresh one once before giving up. */
  const handleVideoError = (): void => {
    if (videoRefreshKey === 0) setVideoRefreshKey(1);
    else setVideoLoadFailed(true);
  };

  const viewerStateSubjectId =
    rememberViewerPosition && (item.mediaType === "video" || item.mediaType === "pdf")
      ? item.id
      : undefined;

  const {
    flushSave,
    initialSnapshot,
    loaded: viewerStateLoaded,
    scheduleSave,
  } = useLibraryViewerState(viewerStateSubjectId, viewerStateStore);

  const resumePdfPage = initialSnapshot?.page;

  const applySpeed = useCallback(
    (nextSpeed: number): void => {
      setSpeed(nextSpeed);

      if (videoRef.current) {
        videoRef.current.playbackRate = nextSpeed;
      }
    },
    [videoRef],
  );

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  /**
   * Seeks to the saved position once both the saved state and the video's
   * duration are known; runs at most once per item, saved position or not.
   */
  const restoreVideoPosition = useCallback((): void => {
    const video = videoRef.current;

    if (hasRestoredVideoRef.current || !viewerStateLoaded || !video) {
      return;
    }

    const loadedDuration = video.duration;

    if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) {
      return;
    }

    hasRestoredVideoRef.current = true;
    const resumeSeconds = resolveVideoResumeSeconds(initialSnapshot?.positionMs, loadedDuration);

    if (resumeSeconds === null) {
      return;
    }

    video.currentTime = resumeSeconds;
    playbackPosition.set(resumeSeconds);
  }, [initialSnapshot?.positionMs, playbackPosition, videoRef, viewerStateLoaded]);

  useEffect(() => {
    if (isVideoItem) restoreVideoPosition();
  }, [isVideoItem, restoreVideoPosition]);

  const skip = useCallback(
    (seconds: number): void => {
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
      playbackPosition.set(clamped);

      if (wasPlaying) {
        void video.play().catch(() => {
          // Keep paused if resume cannot start.
        });
      }
    },
    [videoRef],
  );

  /**
   * Holding a finger on the picture, or the 4 key, plays at 2× until released,
   * then returns to the speed from before the hold.
   */
  const beginHoldBoost = (): void => {
    if (holdBoostActiveRef.current) return;
    holdBoostActiveRef.current = true;
    speedBeforeHoldRef.current = speed;
    setHoldBoosting(true);
    applySpeed(2);
  };

  const endHoldBoost = (): void => {
    if (!holdBoostActiveRef.current) return;
    holdBoostActiveRef.current = false;
    setHoldBoosting(false);
    applySpeed(speedBeforeHoldRef.current);
  };

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (!isVideoItem) {
      return;
    }

    const key = viewerKey(event);

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
      skip(-VIDEO_SKIP_SECONDS);

      return;
    }

    if (key === "3") {
      event.preventDefault();
      skip(VIDEO_SKIP_SECONDS);

      return;
    }

    if (key === "4") {
      event.preventDefault();
      beginHoldBoost();
    }
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "4") endHoldBoost();
  });

  const resetHeldSpeed = useEffectEvent(() => endHoldBoost());

  // Video keys; Escape and stepping belong to the shell.
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

    // Exact, like the scrub preview: fastSeek would snap to a keyframe away from the pick.
    video.currentTime = nextTime;
    playbackPosition.set(nextTime);

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

  const changeVolume = (rawVolume: number): void => {
    const clamped = Math.max(0, Math.min(1, rawVolume));
    setVolume(clamped);

    try {
      window.localStorage.setItem(VIEWER_VOLUME_STORAGE_KEY, String(clamped));
    } catch {
      /* Ignore storage write errors. */
    }

    const video = videoRef.current;

    if (video) {
      video.volume = clamped;

      if (clamped > 0 && video.muted) {
        video.muted = false;
        setMuted(false);
      }
    }
  };

  const toggleMute = (): void => {
    const video = videoRef.current;
    const next = !muted;
    setMuted(next);

    if (video) {
      video.muted = next;
    }
  };

  return {
    applySpeed,
    autoplayVideos,
    beginHoldBoost,
    cache,
    canSeek,
    changeVolume,
    chromeVisibilityClass: shell.chromeVisibilityClass,
    commitSeek,
    duration,
    endHoldBoost,
    flushSave,
    handleVideoError,
    holdBoosting,
    isCoarsePointer: shell.isCoarsePointer,
    isScrubbingRef,
    item,
    loopVideos,
    muted,
    playing,
    playbackPosition,
    restoreVideoPosition,
    resumePdfPage,
    scheduleSave,
    setDuration,
    setPlaying,
    showOriginal: shell.showOriginal,
    skip,
    speed,
    toggleChrome: shell.toggleChrome,
    toggleMute,
    toggleVideoPlayback,
    videoDelivery,
    videoFailed,
    videoRef,
    volume,
  };
}

export type MediaViewerSessionModel = ReturnType<typeof useMediaViewerSession>;

const MediaViewerSessionContext = createContext<MediaViewerSessionModel | null>(null);

export function useMediaViewerSessionModel(): MediaViewerSessionModel {
  const model = useContext(MediaViewerSessionContext);

  if (!model) {
    throw new Error("Media viewer session context is missing");
  }

  return model;
}

export function MediaViewerSession(props: MediaViewerSessionProps): JSX.Element {
  const shell = useViewerShell(props);

  return (
    <ViewerShellContext.Provider value={shell}>
      <ViewerDialog>
        <ViewerItem key={props.item.id} {...props} />
      </ViewerDialog>
    </ViewerShellContext.Provider>
  );
}

function ViewerItem(props: MediaViewerSessionProps): JSX.Element {
  const model = useMediaViewerSession(props);

  return (
    <MediaViewerSessionContext.Provider value={model}>
      <ViewerMedia />
      {/* A video that failed to load has nothing for the controls to drive. */}
      {model.item.mediaType === "video" && !model.videoFailed ? (
        <VideoPlayerChrome model={model} />
      ) : null}
    </MediaViewerSessionContext.Provider>
  );
}

function ViewerDialog({ children }: { children: ReactNode }): JSX.Element {
  const {
    chromeVisible,
    isCoarsePointer,
    isMobile,
    item,
    modalRef,
    onClose,
    revealChrome,
    toggleChrome,
  } = useViewerShellModel();

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
      onMouseMove={() => {
        // Touch taps synthesize a mousemove; only a real cursor should wake the chrome.
        if (!isCoarsePointer) revealChrome();
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") revealChrome();
      }}
    >
      <ViewerTopBar />
      <ViewerNavigation />
      {children}
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
    isFullscreen,
    item,
    onClose,
    showOriginal,
    toggleFullscreen,
    toggleOriginal,
  } = useViewerShellModel();

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-8 pt-3 transition-opacity duration-300 ${chromeVisibilityClass}`}
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <ChromeRegion className="flex items-center justify-between gap-2 sm:gap-3">
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
              onClick={toggleOriginal}
            />
          ) : null}
          <ViewerToolbarButton
            ariaLabel="Toggle fullscreen"
            icon={isFullscreen ? Minimize : Maximize}
            label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
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
      </ChromeRegion>
    </div>
  );
}

function ViewerNavigation(): JSX.Element {
  const { canStepBackward, canStepForward, chromeVisibilityClass, item, onStep } =
    useViewerShellModel();

  // A video keeps its picture for play/pause and hold-to-boost; only the edges step.
  const zoneWidth = item.mediaType === "video" ? "w-[10%]" : "w-1/2";

  return (
    <>
      {item.mediaType !== "pdf" ? (
        <>
          <button
            type="button"
            aria-label="Previous item"
            className={`absolute left-0 top-0 z-10 h-full ${zoneWidth} ${canStepBackward ? "cursor-w-resize" : "cursor-default"} md:hidden`}
            onClick={() => canStepBackward && onStep(-1)}
          />
          <button
            type="button"
            aria-label="Next item"
            className={`absolute right-0 top-0 z-10 h-full ${zoneWidth} ${canStepForward ? "cursor-e-resize" : "cursor-default"} md:hidden`}
            onClick={() => canStepForward && onStep(1)}
          />
        </>
      ) : null}
      <ChromeRegion>
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
      </ChromeRegion>
    </>
  );
}

function ViewerMedia(): JSX.Element {
  const model = useMediaViewerSessionModel();
  const { item } = model;
  const hold = useHoldToBoost(model);

  return (
    <div
      className="flex h-full select-none items-center justify-center p-3 pb-[env(safe-area-inset-bottom)] [-webkit-touch-callout:none]"
      {...hold.handlers}
      onClick={(event) => {
        event.stopPropagation();

        if (item.mediaType !== "video") {
          // Touch has no cursor to wake the chrome; a tap on the image or page shows or hides it.
          if (model.isCoarsePointer) model.toggleChrome();

          return;
        }

        // The tap that ended a hold-to-boost is not a tap on the picture.
        if (hold.consumeSuppressedClick()) return;

        // A tap on the picture shows or hides the controls; a click plays or pauses.
        if (model.isCoarsePointer) model.toggleChrome();
        else model.toggleVideoPlayback();
      }}
    >
      {item.mediaType === "pdf" ? (
        <ViewerPdf model={model} />
      ) : item.mediaType === "video" ? (
        model.videoFailed ? (
          <p className="flex flex-col items-center gap-2 text-sm text-zinc-400">
            <VideoOff className="size-6" />
            This video could not be loaded.
          </p>
        ) : (
          <ViewerVideo model={model} />
        )
      ) : (
        <PaneViewImage
          alt={item.name}
          cache={model.cache}
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
  const { videoRef } = model;

  // A removed <video preload="auto"> keeps downloading until its source is released.
  useEffect(() => {
    const video = videoRef.current;

    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [videoRef]);

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
        video.muted = model.muted;
        video.playbackRate = model.speed;

        if (Number.isFinite(loadedDuration)) model.setDuration(loadedDuration);

        model.restoreVideoPosition();

        if (model.autoplayVideos) void video.play().catch(() => undefined);
      }}
      onDurationChange={(event) => {
        if (Number.isFinite(event.currentTarget.duration))
          model.setDuration(event.currentTarget.duration);
      }}
      onTimeUpdate={(event) => {
        if (model.isScrubbingRef.current) return;
        const currentTime = event.currentTarget.currentTime || 0;
        model.playbackPosition.set(currentTime);
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
      onError={model.handleVideoError}
      src={model.videoDelivery.resolvedUrl ?? undefined}
    />
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

/**
 * The DOM lib declares these on every dialog; jsdom does not have them, so
 * the viewer reads them as optional and falls back.
 */
type OptionalModalDialog = Partial<Pick<HTMLDialogElement, "showModal" | "close">>;

type FullscreenHost = Partial<Pick<HTMLElement, "requestFullscreen">> &
  Partial<{ webkitRequestFullscreen: () => Promise<void> | void }>;

/** Safari's prefixed fullscreen document API, absent from the DOM lib. */
type WebkitFullscreenDocument = Partial<
  Pick<Document, "exitFullscreen" | "fullscreenElement" | "fullscreenEnabled">
> &
  Partial<{
    webkitExitFullscreen: () => Promise<void> | void;
    webkitFullscreenElement: Element | null;
  }>;

function fullscreenElementOf(document: Document): Element | null {
  const doc: WebkitFullscreenDocument = document;

  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** iPhone Safari's video-only fullscreen entry point, absent from the DOM lib. */
type WebkitFullscreenVideo = HTMLVideoElement & Partial<{ webkitEnterFullscreen: () => void }>;

function openDialog(dialog: HTMLDialogElement): void {
  const modal: OptionalModalDialog = dialog;

  if (modal.showModal) {
    modal.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(dialog: HTMLDialogElement): void {
  const modal: OptionalModalDialog = dialog;

  if (modal.close) {
    modal.close();
  } else {
    dialog.removeAttribute("open");
  }
}
