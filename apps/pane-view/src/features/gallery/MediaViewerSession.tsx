import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { Download, Image, type LucideIcon, Maximize, Minimize, X } from "lucide-react";
import {
  forwardRef,
  type JSX,
  lazy,
  type MouseEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  useLibraryViewerState,
  type ViewerStateStore,
} from "@/features/viewer/use-library-viewer-state";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { type CopyStatus, useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useIsMobile } from "@/hooks/use-mobile";
import { useViewerChromeIdle, type ViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { COPY_PATH_ICONS, COPY_PATH_LABELS } from "./copy-path-status";
import { GALLERY_PREVIEW_SIZE } from "./gallery-preview-size";
import { PaneViewImage } from "./PaneViewImage";
import type { ResolvedMediaUrlCache } from "./useResolvedMediaUrl";
import { useViewerDialog } from "./useViewerDialog";
import { useViewerKeyboard } from "./useViewerKeyboard";
import { ViewerStage } from "./ViewerStage";
import type { VideoStatus } from "./video-player/useVideoPlayback";
import { VideoViewer } from "./video-player/VideoViewer";
import { ChromeRegion, formatClock } from "./video-player/video-player-controls";

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

/**
 * The viewer. Its dialog (and the fullscreen it may hold), the idle chrome,
 * the title bar and prev/next outlive a step; only the media and its playback
 * state remount per item.
 */
export function MediaViewerSession({
  autoplayVideos,
  cache,
  canStepBackward,
  canStepForward,
  item,
  loopVideos,
  onClose,
  onStep,
  rememberViewerPosition,
  viewerStateStore,
}: MediaViewerSessionProps): JSX.Element {
  const isMobile = useIsMobile();
  const isCoarsePointer = useCoarsePointer();
  const isVideoItem = item.mediaType === "video";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dialog = useViewerDialog(item.id, videoRef);
  const [videoStatus, setVideoStatus] = useState<(VideoStatus & { mediaId: string }) | null>(null);
  const [originalShownFor, setOriginalShownFor] = useState<string | null>(null);
  const pathCopy = useCopyToClipboard();
  // Tagged with the media id, so a step starts the next item paused and unmeasured.
  const currentVideo = videoStatus?.mediaId === item.id ? videoStatus : null;
  const playing = currentVideo?.playing ?? false;
  const duration = currentVideo?.duration ?? 0;
  const showOriginal = originalShownFor === item.id;

  // Video chrome pins while paused and idles away during playback on every device;
  // other media keep the old rule (idle on desktop, tap to toggle on mobile).
  const chrome = useViewerChromeIdle({
    idleOnMobile: isVideoItem,
    isMobile,
    pinned: isVideoItem && !playing,
  });

  const { chromeVisible, revealChrome, toggleChrome } = chrome;
  const revealForItem = useEffectEvent(() => revealChrome());

  useEffect(() => {
    // Each item arrives with the chrome showing, as when every step remounted the viewer;
    // a phone's step zone also toggles the chrome, which would otherwise hide it every other step.
    revealForItem();
  }, [item.id]);

  const reportVideo = useCallback((mediaId: string, patch: Partial<VideoStatus>): void => {
    setVideoStatus((current) => {
      const base =
        current?.mediaId === mediaId ? current : { duration: 0, mediaId, playing: false };

      return { ...base, ...patch };
    });
  }, []);

  useViewerKeyboard({
    keys: {
      ArrowLeft: () => onStep(-1),
      ArrowRight: () => onStep(1),
      Escape: onClose,
      e: () => onStep(1),
      q: () => onStep(-1),
    },
    onAnyKey: revealChrome,
  });

  return (
    // The dialog is the correct modal primitive; pointer handlers only manage transient chrome.
    // react-doctor-disable-next-line react-doctor/no-noninteractive-element-interactions
    <dialog
      ref={dialog.dialogRef}
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
      <ViewerTopBar
        chrome={chrome}
        closeButtonRef={dialog.closeButtonRef}
        copyStatus={pathCopy.status}
        duration={duration}
        isFullscreen={dialog.isFullscreen}
        item={item}
        onClose={onClose}
        onCopyPath={() => void pathCopy.copy(item.path)}
        onToggleFullscreen={dialog.toggleFullscreen}
        onToggleOriginal={() =>
          setOriginalShownFor((current) => (current === item.id ? null : item.id))
        }
        showOriginal={showOriginal}
      />
      <ViewerNavigation
        canStepBackward={canStepBackward}
        canStepForward={canStepForward}
        chrome={chrome}
        mediaType={item.mediaType}
        onStep={onStep}
      />
      {item.mediaType === "video" ? (
        <VideoViewer
          key={item.id}
          autoplay={autoplayVideos}
          cache={cache}
          chrome={chrome}
          isCoarsePointer={isCoarsePointer}
          loop={loopVideos}
          mediaId={item.id}
          rememberPosition={rememberViewerPosition}
          reportStatus={reportVideo}
          status={{ duration, playing }}
          videoRef={videoRef}
          viewerStateStore={viewerStateStore}
        />
      ) : (
        <ViewerStage
          key={item.id}
          // Touch has no cursor to wake the chrome; a tap on the image or page shows or hides it.
          onTap={() => {
            if (isCoarsePointer) toggleChrome();
          }}
        >
          {item.mediaType === "pdf" ? (
            <ViewerPdf
              item={item}
              rememberPosition={rememberViewerPosition}
              viewerStateStore={viewerStateStore}
            />
          ) : (
            <PaneViewImage
              alt={item.name}
              cache={cache}
              className="max-h-full max-w-full object-contain"
              mediaId={item.id}
              objectFit="contain"
              variant={showOriginal || item.mediaType !== "image" ? "original" : "preview"}
              width={GALLERY_PREVIEW_SIZE}
            />
          )}
        </ViewerStage>
      )}
    </dialog>
  );
}

/** The item's name, size, type, length, and dimensions, as the title bar's second line. */
function itemDetails(item: MediaItem, measuredDuration: number): string[] {
  const durationMs =
    item.mediaType === "video"
      ? item.durationMs && item.durationMs > 0
        ? item.durationMs
        : measuredDuration > 0
          ? Math.round(measuredDuration * 1000)
          : undefined
      : undefined;

  return [
    formatBytes(item.size),
    item.extension.toUpperCase(),
    ...(durationMs ? [formatClock(durationMs / 1000)] : []),
    ...(item.width && item.height ? [`${item.width}×${item.height}`] : []),
  ];
}

function ViewerTopBar({
  chrome,
  closeButtonRef,
  copyStatus,
  duration,
  isFullscreen,
  item,
  onClose,
  onCopyPath,
  onToggleFullscreen,
  onToggleOriginal,
  showOriginal,
}: {
  chrome: ViewerChromeIdle;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  copyStatus: CopyStatus;
  /** The video's measured length, for items whose length was never recorded. */
  duration: number;
  isFullscreen: boolean;
  item: MediaItem;
  onClose: () => void;
  onCopyPath: () => void;
  onToggleFullscreen: () => void;
  onToggleOriginal: () => void;
  showOriginal: boolean;
}): JSX.Element {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-8 pt-3 transition-opacity duration-300 ${chrome.chromeVisibilityClass}`}
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <ChromeRegion
        className="flex items-center justify-between gap-2 sm:gap-3"
        hidden={!chrome.chromeVisible}
        onReveal={chrome.revealChrome}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">{item.name}</p>
          <p className="truncate text-xs text-white/70">
            {itemDetails(item, duration).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ViewerToolbarButton
            ariaLabel="Copy path"
            icon={COPY_PATH_ICONS[copyStatus]}
            label={COPY_PATH_LABELS[copyStatus]}
            onClick={onCopyPath}
          />
          <span aria-live="polite" className="sr-only">
            {copyStatus === "idle" ? "" : COPY_PATH_LABELS[copyStatus]}
          </span>
          <ViewerToolbarButton
            ariaLabel="Download"
            icon={Download}
            label="Download"
            onClick={() =>
              window.open(`/api/media/${item.id}/original`, "_blank", "noopener,noreferrer")
            }
          />
          {item.mediaType === "image" ? (
            <ViewerToolbarButton
              ariaLabel={showOriginal ? "Show preview" : "Show original"}
              icon={Image}
              label={showOriginal ? "Preview" : "Original"}
              onClick={onToggleOriginal}
            />
          ) : null}
          <ViewerToolbarButton
            ariaLabel="Toggle fullscreen"
            icon={isFullscreen ? Minimize : Maximize}
            label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={onToggleFullscreen}
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

function ViewerNavigation({
  canStepBackward,
  canStepForward,
  chrome,
  mediaType,
  onStep,
}: {
  canStepBackward: boolean;
  canStepForward: boolean;
  chrome: ViewerChromeIdle;
  mediaType: string;
  onStep: (delta: -1 | 1) => void;
}): JSX.Element {
  // A video keeps its picture for play/pause and hold-to-boost; only the edges step.
  const zoneWidth = mediaType === "video" ? "w-[10%]" : "w-1/2";

  return (
    <>
      {mediaType !== "pdf" ? (
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
      <ChromeRegion hidden={!chrome.chromeVisible} onReveal={chrome.revealChrome}>
        <button
          type="button"
          aria-label="Previous item"
          className={`absolute left-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chrome.chromeVisibilityClass} ${canStepBackward ? "" : "pointer-events-none opacity-40"}`}
          onClick={() => onStep(-1)}
          disabled={!canStepBackward}
        >
          {"<"}
        </button>
        <button
          type="button"
          aria-label="Next item"
          className={`absolute right-3 top-1/2 z-20 hidden h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-xl text-white/90 transition-opacity duration-300 hover:bg-violet-500/25 hover:text-violet-100 md:flex ${chrome.chromeVisibilityClass} ${canStepForward ? "" : "pointer-events-none opacity-40"}`}
          onClick={() => onStep(1)}
          disabled={!canStepForward}
        >
          {">"}
        </button>
      </ChromeRegion>
    </>
  );
}

function ViewerPdf({
  item,
  rememberPosition,
  viewerStateStore,
}: {
  item: MediaItem;
  rememberPosition: boolean;
  viewerStateStore?: ViewerStateStore;
}): JSX.Element {
  const { flushSave, initialSnapshot, scheduleSave } = useLibraryViewerState(
    rememberPosition ? item.id : undefined,
    viewerStateStore,
  );

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  return (
    <Suspense fallback={<p className="text-sm text-zinc-400">Loading PDF…</p>}>
      <PdfViewer
        initialPage={initialSnapshot?.page}
        mediaId={item.id}
        onPageChange={(page) => scheduleSave({ page })}
        title={item.name}
      />
    </Suspense>
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
