import { VideoOff } from "lucide-react";
import { type JSX, type RefObject, useEffect } from "react";
import { VIDEO_SKIP_SECONDS } from "@/features/viewer/video-playback";
import type { ViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { useViewerKeyboard } from "../useViewerKeyboard";
import { ViewerStage } from "../ViewerStage";
import {
  type UseVideoPlaybackOptions,
  useVideoPlayback,
  type VideoElementProps,
} from "./useVideoPlayback";
import { VideoPlayerChrome } from "./VideoPlayerChrome";
import { useHoldToBoost } from "./video-player-controls";

export interface VideoViewerProps extends UseVideoPlaybackOptions {
  chrome: ViewerChromeIdle;
  isCoarsePointer: boolean;
}

/** One video in the viewer: the picture, its keys and gestures, and the capsule controls. */
export function VideoViewer({
  chrome,
  isCoarsePointer,
  ...options
}: VideoViewerProps): JSX.Element {
  const { failed, playback, videoProps } = useVideoPlayback(options);
  const hold = useHoldToBoost(playback);

  // Escape and stepping belong to the viewer.
  useViewerKeyboard({
    keys: {
      " ": playback.togglePlayback,
      "1": () => playback.skip(-VIDEO_SKIP_SECONDS),
      "2": playback.togglePlayback,
      "3": () => playback.skip(VIDEO_SKIP_SECONDS),
      "4": playback.beginHoldBoost,
    },
    onBlur: playback.endHoldBoost,
    onKeyUp: (event) => {
      if (event.key === "4") playback.endHoldBoost();
    },
  });

  return (
    <>
      <ViewerStage
        holdHandlers={hold.handlers}
        onTap={() => {
          // The tap that ended a hold-to-boost is not a tap on the picture.
          if (hold.consumeSuppressedClick()) return;

          // A tap on the picture shows or hides the controls; a click plays or pauses.
          if (isCoarsePointer) chrome.toggleChrome();
          else playback.togglePlayback();
        }}
      >
        {failed ? (
          <p className="flex flex-col items-center gap-2 text-sm text-zinc-400">
            <VideoOff className="size-6" />
            This video could not be loaded.
          </p>
        ) : (
          <VideoElement videoRef={options.videoRef} {...videoProps} />
        )}
      </ViewerStage>
      {/* A video that failed to load has nothing for the controls to drive. */}
      {failed ? null : <VideoPlayerChrome chrome={chrome} playback={playback} />}
    </>
  );
}

function VideoElement({
  videoRef,
  ...videoProps
}: VideoElementProps & { videoRef: RefObject<HTMLVideoElement | null> }): JSX.Element {
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
    // No <track>: caption sidecars are not ingested yet.
    <video
      ref={videoRef}
      className="max-h-full max-w-full bg-black object-contain"
      preload="auto"
      playsInline
      {...videoProps}
    />
  );
}
