import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { MediaItem } from '../../shared/types';

const VIEWER_VOLUME_STORAGE_KEY = 'frameview.viewer.volume';
const VIEWER_MUTED_STORAGE_KEY = 'frameview.viewer.muted';

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

function readPersistedMuted(): boolean {
  try {
    return window.localStorage.getItem(VIEWER_MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors.
  }
}

/**
 * The DOM lib declares these on every element; Chrome (fastSeek) and Safari
 * (prefixed fullscreen) differ, so the viewer reads them as optional.
 */
type OptionalFastSeek = Partial<Pick<HTMLMediaElement, 'fastSeek'>>;
type FullscreenHost = Partial<Pick<HTMLElement, 'requestFullscreen'>> &
  Partial<{ webkitRequestFullscreen: () => Promise<void> | void }>;
type WebkitFullscreenDocument = Partial<
  Pick<Document, 'exitFullscreen' | 'fullscreenElement' | 'fullscreenEnabled'>
> &
  Partial<{
    webkitExitFullscreen: () => Promise<void> | void;
    webkitFullscreenElement: Element | null;
  }>;
type WebkitFullscreenVideo = HTMLVideoElement & Partial<{ webkitEnterFullscreen: () => void }>;

function fullscreenElementOf(document: Document): Element | null {
  const doc: WebkitFullscreenDocument = document;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

interface UseViewerVideoModelOptions {
  autoplayVideos: boolean;
  item: MediaItem;
  loopVideos: boolean;
  modalRef: RefObject<HTMLDialogElement | null>;
}

/** Everything the video capsule, the picture and the hotkeys read or drive. */
export interface ViewerVideoModel {
  applySpeed: (speed: number) => void;
  autoplayVideos: boolean;
  beginHoldBoost: () => void;
  canSeek: boolean;
  changeVolume: (volume: number) => void;
  commitSeek: (seconds: number) => void;
  duration: number;
  endHoldBoost: () => void;
  holdBoosting: boolean;
  isFullscreen: boolean;
  isScrubbingRef: RefObject<boolean>;
  item: MediaItem;
  loopVideos: boolean;
  muted: boolean;
  playing: boolean;
  position: number;
  setDuration: Dispatch<SetStateAction<number>>;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setPosition: Dispatch<SetStateAction<number>>;
  skip: (seconds: number) => void;
  speed: number;
  toggleFullscreen: () => Promise<void>;
  toggleMute: () => void;
  toggleVideoPlayback: () => void;
  videoRef: RefObject<HTMLVideoElement | null>;
  volume: number;
}

/**
 * Playback state and actions for the item shown in the viewer. Volume and
 * mute persist across sessions; speed is per viewer session; hold-to-boost
 * (touch press on the picture, or the `4` key) plays at 2× and restores the
 * speed chosen before the hold.
 */
export function useViewerVideoModel({
  autoplayVideos,
  item,
  loopVideos,
  modalRef,
}: UseViewerVideoModelOptions): ViewerVideoModel {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isScrubbingRef = useRef(false);
  const speedBeforeHoldRef = useRef(1);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(() => readPersistedVolume());
  const [muted, setMuted] = useState(() => readPersistedMuted());
  const [speed, setSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [holdBoosting, setHoldBoosting] = useState(false);

  useEffect(() => {
    const onFullscreenChange = (): void => setIsFullscreen(fullscreenElementOf(document) !== null);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  const applySpeed = useCallback((nextSpeed: number): void => {
    setSpeed(nextSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
  }, []);

  const canSeek = Number.isFinite(duration) && duration > 0;

  const commitSeek = useCallback((rawTarget: number): void => {
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

    const seeker: OptionalFastSeek = video;
    if (seeker.fastSeek) {
      seeker.fastSeek(nextTime);
    } else {
      video.currentTime = nextTime;
    }

    setPosition(nextTime);

    if (wasPlaying) {
      void video.play().catch(() => {
        // Keep paused if resume cannot start.
      });
    }
  }, []);

  const skip = useCallback(
    (seconds: number): void => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      commitSeek(video.currentTime + seconds);
    },
    [commitSeek],
  );

  const toggleVideoPlayback = useCallback((): void => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const toggleFullscreen = useCallback(async (): Promise<void> => {
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

    // Element fullscreen where the platform allows it; otherwise the video
    // itself can still go full screen with its native player.
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
  }, [modalRef]);

  const changeVolume = useCallback((rawVolume: number): void => {
    const clamped = Math.max(0, Math.min(1, rawVolume));
    setVolume(clamped);
    persist(VIEWER_VOLUME_STORAGE_KEY, String(clamped));
    const video = videoRef.current;
    if (video) {
      video.volume = clamped;
      if (clamped > 0 && video.muted) {
        video.muted = false;
        setMuted(false);
        persist(VIEWER_MUTED_STORAGE_KEY, '0');
      }
    }
  }, []);

  const toggleMute = useCallback((): void => {
    const next = !muted;
    setMuted(next);
    if (videoRef.current) {
      videoRef.current.muted = next;
    }
    persist(VIEWER_MUTED_STORAGE_KEY, next ? '1' : '0');
  }, [muted]);

  const beginHoldBoost = useCallback((): void => {
    if (holdBoosting) return;
    speedBeforeHoldRef.current = speed;
    setHoldBoosting(true);
    applySpeed(2);
  }, [applySpeed, holdBoosting, speed]);

  const endHoldBoost = useCallback((): void => {
    if (!holdBoosting) return;
    setHoldBoosting(false);
    applySpeed(speedBeforeHoldRef.current);
  }, [applySpeed, holdBoosting]);

  return {
    applySpeed,
    autoplayVideos,
    beginHoldBoost,
    canSeek,
    changeVolume,
    commitSeek,
    duration,
    endHoldBoost,
    holdBoosting,
    isFullscreen,
    isScrubbingRef,
    item,
    loopVideos,
    muted,
    playing,
    position,
    setDuration,
    setPlaying,
    setPosition,
    skip,
    speed,
    toggleFullscreen,
    toggleMute,
    toggleVideoPlayback,
    videoRef,
    volume,
  };
}
