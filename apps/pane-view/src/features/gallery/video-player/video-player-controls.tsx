import { type LucideIcon, RotateCcw, RotateCw, Volume1, Volume2, VolumeX } from "lucide-react";
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { VIDEO_SKIP_SECONDS } from "@/features/viewer/video-playback";
import { IconButton } from "../viewer-chrome";
import { type PlaybackPosition, usePlaybackPosition } from "./playback-position";
import type { VideoPlayback } from "./useVideoPlayback";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secs}`;
  }

  return `${minutes}:${secs}`;
}

export function formatSpeed(speed: number): string {
  return `${speed}×`;
}

export function volumeIconFor(level: number): LucideIcon {
  return level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
}

/**
 * False where the page cannot set a video's volume: iOS leaves it to the
 * hardware buttons and ignores the write, which a read-back reveals.
 */
export function canSetVideoVolume(): boolean {
  const probe = document.createElement("video");
  probe.volume = 0.5;

  return probe.volume === 0.5;
}

/**
 * A chrome surface: clicks inside never reach the dialog's tap-to-toggle handler.
 * While the chrome is hidden nothing in it takes a click or tap; one on the region
 * only brings the chrome back. Its controls stay reachable from the keyboard.
 */
export function ChromeRegion({
  children,
  className = "",
  hidden,
  onReveal,
  style,
}: {
  children: ReactNode;
  className?: string;
  hidden: boolean;
  onReveal: () => void;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div
      className={`pointer-events-auto ${hidden ? "**:pointer-events-none" : ""} ${className}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();

        if (hidden) onReveal();
      }}
    >
      {children}
    </div>
  );
}

/** The ±10 s button: a circular arrow with the second count inside. */
export function SkipButton({
  direction,
  playback,
}: {
  direction: -1 | 1;
  playback: VideoPlayback;
}): JSX.Element {
  const label =
    direction < 0 ? `Back ${VIDEO_SKIP_SECONDS} seconds` : `Forward ${VIDEO_SKIP_SECONDS} seconds`;

  return (
    <IconButton
      className="relative"
      icon={direction < 0 ? RotateCcw : RotateCw}
      label={label}
      onClick={() => playback.skip(direction * VIDEO_SKIP_SECONDS)}
      size="sm"
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center pt-px text-[7px] font-bold tabular-nums"
      >
        {VIDEO_SKIP_SECONDS}
      </span>
    </IconButton>
  );
}

interface FractionDragOptions {
  /** `y` reads bottom-to-top, for vertical sliders. */
  axis?: "x" | "y";
  disabled?: boolean;
  onCommit: (fraction: number) => void;
  onScrub: (fraction: number) => void;
}

export interface FractionDrag {
  hoverFraction: number | null;
  scrubbing: boolean;
  trackProps: {
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave: () => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    style: CSSProperties;
  };
  trackRef: RefObject<HTMLDivElement | null>;
}

/**
 * Drag along a track, as a 0..1 fraction. Pointer capture keeps a drag alive
 * when the finger leaves the track, and `touch-action: none` stops the page
 * from scrolling instead of scrubbing.
 */
export function useFractionDrag({
  axis = "x",
  disabled = false,
  onCommit,
  onScrub,
}: FractionDragOptions): FractionDrag {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverFraction, setHoverFraction] = useState<number | null>(null);

  const fractionAt = (clientX: number, clientY: number): number => {
    const track = trackRef.current;

    if (!track) return 0;
    const rect = track.getBoundingClientRect();

    const raw =
      axis === "y"
        ? rect.height <= 0
          ? 0
          : 1 - (clientY - rect.top) / rect.height
        : rect.width <= 0
          ? 0
          : (clientX - rect.left) / rect.width;

    return Math.max(0, Math.min(1, raw));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    onScrub(fractionAt(event.clientX, event.clientY));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (scrubbing) {
      onScrub(fractionAt(event.clientX, event.clientY));

      return;
    }

    if (event.pointerType === "mouse" && !disabled) {
      setHoverFraction(fractionAt(event.clientX, event.clientY));
    }
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    setScrubbing(false);
    onCommit(fractionAt(event.clientX, event.clientY));
  };

  return {
    hoverFraction,
    scrubbing,
    trackProps: {
      onPointerCancel: finish,
      onPointerDown,
      onPointerLeave: () => setHoverFraction(null),
      onPointerMove,
      onPointerUp: finish,
      style: { touchAction: "none" },
    },
    trackRef,
  };
}

interface SeekControl {
  ariaProps: {
    "aria-label": string;
    "aria-valuemax": number;
    "aria-valuemin": number;
    "aria-valuenow": number;
    "aria-valuetext": string;
    role: "slider";
    tabIndex: number;
  };
  drag: FractionDrag;
  /** Played share of the timeline, 0..1. */
  fraction: number;
  /** Seconds under the mouse, when hovering the track. */
  hoverTime: number | null;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** Seek state and gestures against the session's video: tap to jump, drag to scrub. */
function useSeek(playback: VideoPlayback): SeekControl {
  const { duration } = playback;
  const canSeek = Number.isFinite(duration) && duration > 0;
  const position = usePlaybackPosition(playback.position);
  const commit = (fraction: number) => playback.commitSeek(fraction * duration);

  const drag = useFractionDrag({
    disabled: !canSeek,
    onCommit: commit,
    onScrub: (fraction) => playback.scrubTo(fraction * duration),
  });

  const fraction = canSeek ? Math.max(0, Math.min(1, position / duration)) : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      playback.skip(event.key === "ArrowLeft" ? -VIDEO_SKIP_SECONDS : VIDEO_SKIP_SECONDS);

      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      commit(event.key === "Home" ? 0 : 1);
    }
  };

  return {
    ariaProps: {
      "aria-label": "Video seek position",
      "aria-valuemax": Math.round(duration),
      "aria-valuemin": 0,
      "aria-valuenow": Math.round(position),
      "aria-valuetext": `${formatClock(position)} of ${formatClock(duration)}`,
      role: "slider",
      tabIndex: 0,
    },
    drag,
    fraction,
    hoverTime: drag.hoverFraction === null ? null : drag.hoverFraction * duration,
    onKeyDown,
  };
}

/** The horizontal seek bar: played fill, thumb, hover time on desktop. */
export function SeekTrack({ playback }: { playback: VideoPlayback }): JSX.Element {
  const seek = useSeek(playback);
  const { drag, fraction } = seek;
  const played = `${fraction * 100}%`;

  return (
    <div
      ref={drag.trackRef}
      {...drag.trackProps}
      {...seek.ariaProps}
      onKeyDown={seek.onKeyDown}
      className="relative flex h-8 w-full cursor-pointer items-center outline-none focus-visible:[&>div:first-child]:ring-2 focus-visible:[&>div:first-child]:ring-violet-400/70"
    >
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/25">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-violet-400"
          style={{ width: played }}
        />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md"
        style={{ left: played }}
      />
      {seek.hoverTime !== null && !drag.scrubbing ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded-md bg-zinc-900/90 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white ring-1 ring-white/10"
          style={{ left: `${(drag.hoverFraction ?? 0) * 100}%` }}
        >
          {formatClock(seek.hoverTime)}
        </div>
      ) : null}
    </div>
  );
}

/** The elapsed-time label; the only other subscriber to the playhead. */
export function ElapsedClock({ position }: { position: PlaybackPosition }): JSX.Element {
  return <span className="w-9 shrink-0">{formatClock(usePlaybackPosition(position))}</span>;
}

/** Closes a panel on a pointer press outside `rootRef`, or on Escape. */
export function useOutsideClose(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: globalThis.PointerEvent) => {
      const root = rootRef.current;

      if (root && event.target instanceof Node && root.contains(event.target)) return;
      onClose();
    };

    // Window capture runs before the viewer's own Escape handling, so an open
    // panel takes the first Escape and the viewer (and its dialog) the next.
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose, open, rootRef]);
}

const HOLD_BOOST_DELAY_MS = 350;

export interface HoldToBoost {
  /** True when the click that follows a finished hold should be ignored. */
  consumeSuppressedClick: () => boolean;
  handlers: {
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
    onPointerCancel: () => void;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave: () => void;
    onPointerUp: () => void;
  };
}

/**
 * Press and hold a playing video on a touch screen to play at 2× until the
 * finger lifts. Any part of the picture works, so a thumb resting at the side
 * of a tablet reaches it; the prev/next zones and the chrome sit above the
 * picture and take their own presses.
 */
export function useHoldToBoost(playback: VideoPlayback): HoldToBoost {
  const timerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const { beginHoldBoost, endHoldBoost, holdBoosting, playing } = playback;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stop = () => {
    clearTimer();

    if (holdBoosting) {
      endHoldBoost();
      suppressClickRef.current = true;
    }
  };

  useEffect(() => clearTimer, []);

  return {
    consumeSuppressedClick: () => {
      const suppressed = suppressClickRef.current;
      suppressClickRef.current = false;

      return suppressed;
    },
    handlers: {
      onContextMenu: (event) => {
        if (holdBoosting || timerRef.current !== null) event.preventDefault();
      },
      onPointerCancel: stop,
      onPointerDown: (event) => {
        if (event.pointerType === "mouse" || !playing) return;
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          beginHoldBoost();
        }, HOLD_BOOST_DELAY_MS);
      },
      onPointerLeave: stop,
      onPointerUp: stop,
    },
  };
}
