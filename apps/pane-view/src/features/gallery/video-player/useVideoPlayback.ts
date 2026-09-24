import {
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useLibraryViewerState,
  type ViewerStateStore,
} from "@/features/viewer/use-library-viewer-state";
import {
  resolveVideoResumeSeconds,
  videoSecondsToPositionMs,
} from "@/features/viewer/viewer-resume";
import { type ResolvedMediaUrlCache, useResolvedMediaUrl } from "../useResolvedMediaUrl";
import { createPlaybackPosition, type PlaybackPosition } from "./playback-position";

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

/** What the viewer's shared chrome needs from the current video; the video reports it. */
export interface VideoStatus {
  duration: number;
  playing: boolean;
}

/** One video's playback, as the controls see it. */
export interface VideoPlayback {
  /** Seconds; 0 until the video has measured itself. */
  duration: number;
  holdBoosting: boolean;
  muted: boolean;
  playing: boolean;
  /** The playhead, outside React state; see PlaybackPosition. */
  position: PlaybackPosition;
  speed: number;
  /** 0..1, the level to return to when unmuted. */
  volume: number;
  /** Plays at 2× until `endHoldBoost`, then returns to the speed from before. */
  beginHoldBoost(): void;
  /** Lands a scrub or a seek-bar key on `seconds`, exactly, and saves the position. */
  commitSeek(seconds: number): void;
  endHoldBoost(): void;
  /** Shows `seconds` while the seek bar is dragged. */
  scrubTo(seconds: number): void;
  setSpeed(speed: number): void;
  setVolume(volume: number): void;
  skip(seconds: number): void;
  toggleMute(): void;
  togglePlayback(): void;
}

type VideoEventHandler = (event: SyntheticEvent<HTMLVideoElement>) => void;

/** The props the session puts on its `<video>`. */
export interface VideoElementProps {
  loop: boolean;
  onDurationChange: VideoEventHandler;
  onEnded: () => void;
  onError: () => void;
  onLoadedMetadata: VideoEventHandler;
  onPause: VideoEventHandler;
  onPlay: () => void;
  onTimeUpdate: VideoEventHandler;
  src: string | undefined;
}

export interface VideoSession {
  /** The video could not be loaded, even from a freshly resolved URL. */
  failed: boolean;
  playback: VideoPlayback;
  videoProps: VideoElementProps;
}

export interface UseVideoPlaybackOptions {
  autoplay: boolean;
  /** Overrides the shared URL cache; tests inject a cache with a fake resolver. */
  cache?: ResolvedMediaUrlCache;
  loop: boolean;
  mediaId: string;
  /** Resume from, and save to, the remembered position. */
  rememberPosition: boolean;
  /** Tells the viewer about duration and play-state changes; the viewer owns both. */
  reportStatus: (mediaId: string, patch: Partial<VideoStatus>) => void;
  /** The last status reported for this video. */
  status: VideoStatus;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Overrides the viewer-state server calls; tests inject an in-memory store. */
  viewerStateStore?: ViewerStateStore;
}

/** One video's session: its URL, playback, remembered position, and controls. */
export function useVideoPlayback({
  autoplay,
  cache,
  loop,
  mediaId,
  rememberPosition,
  reportStatus,
  status,
  videoRef,
  viewerStateStore,
}: UseVideoPlaybackOptions): VideoSession {
  const scrubbingRef = useRef(false);
  const scrubFrameRef = useRef<number | null>(null);
  const scrubTargetRef = useRef<number | null>(null);
  const holdBoostActiveRef = useRef(false);
  const speedBeforeHoldRef = useRef(1);
  const hasRestoredRef = useRef(false);

  const [position] = useState(createPlaybackPosition);
  const [volume, setVolumeState] = useState(() => readPersistedVolume());
  const [muted, setMuted] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [holdBoosting, setHoldBoosting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  const delivery = useResolvedMediaUrl({ cache, mediaId, refreshKey, variant: "original" });

  const {
    flushSave,
    initialSnapshot,
    loaded: viewerStateLoaded,
    scheduleSave,
  } = useLibraryViewerState(rememberPosition ? mediaId : undefined, viewerStateStore);

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  const setSpeed = useCallback(
    (nextSpeed: number): void => {
      setSpeedState(nextSpeed);

      if (videoRef.current) {
        videoRef.current.playbackRate = nextSpeed;
      }
    },
    [videoRef],
  );

  /**
   * Seeks to the saved position once both the saved state and the video's
   * duration are known; runs at most once per item, saved position or not.
   * Whichever arrives last triggers it: the state (the effect below) or the
   * metadata (`onLoadedMetadata`).
   */
  const restorePosition = useCallback((): void => {
    const video = videoRef.current;

    if (hasRestoredRef.current || !viewerStateLoaded || !video) {
      return;
    }

    const loadedDuration = video.duration;

    if (!Number.isFinite(loadedDuration) || loadedDuration <= 0) {
      return;
    }

    hasRestoredRef.current = true;
    const resumeSeconds = resolveVideoResumeSeconds(initialSnapshot?.positionMs, loadedDuration);

    if (resumeSeconds === null) {
      return;
    }

    video.currentTime = resumeSeconds;
    position.set(resumeSeconds);
  }, [initialSnapshot?.positionMs, position, videoRef, viewerStateLoaded]);

  useEffect(() => {
    restorePosition();
  }, [restorePosition]);

  /** Moves the playhead to `seconds`, clamped to the video, and keeps playing if it was. */
  const seekTo = (seconds: number): void => {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const total = video.duration;

    if (!Number.isFinite(total) || total <= 0) {
      return;
    }

    const safeTotal = Math.max(0, total - 0.05);
    const nextTime = Math.max(0, Math.min(safeTotal, seconds));
    const wasPlaying = !video.paused;

    // Exact, like the scrub preview: fastSeek would snap to a keyframe away from the pick.
    video.currentTime = nextTime;
    position.set(nextTime);

    if (wasPlaying) {
      void video.play().catch(() => {
        // Keep paused if resume cannot start.
      });
    }
  };

  const playback: VideoPlayback = {
    beginHoldBoost: () => {
      if (holdBoostActiveRef.current) return;
      holdBoostActiveRef.current = true;
      speedBeforeHoldRef.current = speed;
      setHoldBoosting(true);
      setSpeed(2);
    },
    commitSeek: (seconds) => {
      scrubbingRef.current = false;
      seekTo(seconds);
      scheduleSave({ positionMs: videoSecondsToPositionMs(seconds) });
      void flushSave();
    },
    duration: status.duration,
    endHoldBoost: () => {
      if (!holdBoostActiveRef.current) return;
      holdBoostActiveRef.current = false;
      setHoldBoosting(false);
      setSpeed(speedBeforeHoldRef.current);
    },
    holdBoosting,
    muted,
    playing: status.playing,
    position,
    scrubTo: (seconds) => {
      scrubbingRef.current = true;
      position.set(seconds);
      scrubTargetRef.current = seconds;

      if (scrubFrameRef.current === null) {
        scrubFrameRef.current = window.requestAnimationFrame(() => {
          scrubFrameRef.current = null;
          const video = videoRef.current;

          if (video && scrubTargetRef.current !== null) {
            video.currentTime = scrubTargetRef.current;
          }
        });
      }
    },
    setSpeed,
    setVolume: (rawVolume) => {
      const clamped = Math.max(0, Math.min(1, rawVolume));
      setVolumeState(clamped);

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
    },
    skip: (seconds) => {
      const video = videoRef.current;

      if (video) {
        seekTo(video.currentTime + seconds);
      }
    },
    speed,
    toggleMute: () => {
      const video = videoRef.current;
      const next = !muted;
      setMuted(next);

      if (video) {
        video.muted = next;
      }
    },
    togglePlayback: () => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      if (video.paused) {
        void video.play();
      } else {
        video.pause();
      }
    },
    volume,
  };

  const videoProps: VideoElementProps = {
    loop,
    onDurationChange: (event) => {
      if (Number.isFinite(event.currentTarget.duration)) {
        reportStatus(mediaId, { duration: event.currentTarget.duration });
      }
    },
    onEnded: () => reportStatus(mediaId, { playing: false }),
    // The cached URL may have expired: resolve a fresh one once before giving up.
    onError: () => {
      if (refreshKey === 0) setRefreshKey(1);
      else setLoadFailed(true);
    },
    onLoadedMetadata: (event) => {
      const video = event.currentTarget;
      const loadedDuration = video.duration;
      video.volume = volume;
      video.muted = muted;
      video.playbackRate = speed;

      if (Number.isFinite(loadedDuration)) reportStatus(mediaId, { duration: loadedDuration });

      restorePosition();

      // Started here rather than by `autoplay`, so playback begins at the restored position.
      if (autoplay) void video.play().catch(() => undefined);
    },
    onPause: (event) => {
      reportStatus(mediaId, { playing: false });

      if (!scrubbingRef.current) {
        scheduleSave({
          positionMs: videoSecondsToPositionMs(event.currentTarget.currentTime || 0),
        });
        void flushSave();
      }
    },
    onPlay: () => reportStatus(mediaId, { playing: true }),
    onTimeUpdate: (event) => {
      if (scrubbingRef.current) return;
      const currentTime = event.currentTarget.currentTime || 0;
      position.set(currentTime);
      scheduleSave({ positionMs: videoSecondsToPositionMs(currentTime) });
    },
    src: delivery.resolvedUrl ?? undefined,
  };

  return { failed: delivery.failed || loadFailed, playback, videoProps };
}
