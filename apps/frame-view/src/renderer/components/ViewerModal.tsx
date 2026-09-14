import { type JSX, useCallback, useEffect, useRef } from 'react';

import type { MediaItem } from '../../shared/types';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import { useViewerChromeIdle } from '../hooks/useViewerChromeIdle';
import { useViewerKeyboardControls } from '../hooks/useViewerKeyboardControls';
import { useViewerVideoModel, type ViewerVideoModel } from '../hooks/useViewerVideoModel';
import { formatBytes, formatDuration, toFileUrl } from '../utils/path';
import { ViewerChrome } from './viewer/ViewerChrome';
import { VideoPlayerChrome } from './viewer/video-player/VideoPlayerChrome';
import { useHoldToBoost } from './viewer/video-player/video-player-controls';

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

export function ViewerModal({ items, index, ...rest }: ViewerModalProps): JSX.Element | null {
  const item = items[index];
  if (!item) {
    return null;
  }

  return <ViewerDialog item={item} {...rest} />;
}

interface ViewerDialogProps extends Omit<ViewerModalProps, 'items' | 'index'> {
  item: MediaItem;
}

function ViewerDialog({
  item,
  autoplayVideos,
  loopVideos,
  canStepBackward,
  canStepForward,
  onClose,
  onStep,
}: ViewerDialogProps): JSX.Element {
  const isVideoItem = item.mediaType === 'video';
  const modalRef = useRef<HTMLDialogElement | null>(null);
  const queuedStepRef = useRef(0);
  const stepFrameRef = useRef<number | null>(null);
  const isCoarsePointer = useCoarsePointer();

  const model = useViewerVideoModel({ autoplayVideos, item, loopVideos, modalRef });
  // Video chrome pins while paused and idles away during playback.
  const chromePinned = isVideoItem && !model.playing;
  const { chromeVisible, revealChrome, toggleChrome, chromeVisibilityClass } = useViewerChromeIdle({
    pinned: chromePinned,
  });
  const hold = useHoldToBoost(model);

  useEffect(() => {
    const dialog = modalRef.current;
    dialog?.showModal();
    return () => dialog?.close();
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

  useViewerKeyboardControls({ isVideoItem, model, onClose, queueStep, revealChrome });

  const details = buildViewerDetails(item, model.duration);

  return (
    <dialog
      ref={modalRef}
      aria-label={`Viewer for ${item.name}`}
      className={`dark fixed inset-0 z-50 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-zinc-950/95 p-0 text-zinc-100 backdrop:bg-zinc-950 ${chromeVisible ? '' : 'cursor-none'}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseMove={() => {
        // Touch taps synthesize a mousemove; only a real cursor should wake the chrome.
        if (!isCoarsePointer) revealChrome();
      }}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') revealChrome();
      }}
    >
      <ViewerChrome
        canStepBackward={canStepBackward}
        canStepForward={canStepForward}
        chromeVisibilityClass={chromeVisibilityClass}
        details={details}
        isFullscreen={model.isFullscreen}
        item={item}
        onClose={onClose}
        onStep={onStep}
        onToggleFullscreen={() => void model.toggleFullscreen()}
      />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: the picture takes play/pause and hold-to-boost; the hotkeys cover the keyboard */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
      <div
        className="flex h-full select-none items-center justify-center p-3 [-webkit-touch-callout:none]"
        {...hold.handlers}
        onClick={() => {
          if (!isVideoItem) return;
          // The tap that ended a hold-to-boost is not a tap on the picture.
          if (hold.consumeSuppressedClick()) return;
          // A tap on the picture shows or hides the controls; a click plays or pauses.
          if (isCoarsePointer) toggleChrome();
          else model.toggleVideoPlayback();
        }}
      >
        {item.mediaType === 'image' ? (
          <img
            src={toFileUrl(item.path)}
            alt={item.name}
            className="max-h-full max-w-full object-contain [outline:1px_solid_rgba(255,255,255,0.1)]"
          />
        ) : (
          <ViewerVideo model={model} />
        )}
      </div>

      {isVideoItem ? (
        <VideoPlayerChrome chromeVisibilityClass={chromeVisibilityClass} model={model} />
      ) : null}
    </dialog>
  );
}

function ViewerVideo({ model }: { model: ViewerVideoModel }): JSX.Element {
  const { item } = model;
  return (
    <video
      key={item.id}
      ref={model.videoRef}
      src={toFileUrl(item.path)}
      className="max-h-full max-w-full bg-black object-contain"
      autoPlay={model.autoplayVideos}
      loop={model.loopVideos}
      preload="auto"
      playsInline
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        const loadedDuration = video.duration;
        video.volume = model.volume;
        video.muted = model.muted;
        video.playbackRate = model.speed;
        if (Number.isFinite(loadedDuration)) {
          model.setDuration(loadedDuration);
        }
        if (model.autoplayVideos) {
          void video.play().catch(() => {
            // Ignore autoplay failures caused by platform policy.
          });
        }
      }}
      onDurationChange={(event) => {
        const nextDuration = event.currentTarget.duration;
        if (Number.isFinite(nextDuration)) {
          model.setDuration(nextDuration);
        }
      }}
      onTimeUpdate={(event) => {
        if (!model.isScrubbingRef.current) {
          model.setPosition(event.currentTarget.currentTime || 0);
        }
      }}
      onPlay={() => model.setPlaying(true)}
      onPause={() => model.setPlaying(false)}
      onEnded={(event) => {
        if (model.loopVideos) {
          event.currentTarget.currentTime = 0;
          void event.currentTarget.play().catch(() => {
            // Keep ended state if replay cannot start.
          });
        } else {
          model.setPlaying(false);
        }
      }}
    />
  );
}
