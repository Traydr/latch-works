import { FastForward, Pause, Play, Settings } from "lucide-react";
import { type JSX, type ReactNode, useRef, useState } from "react";
import type { ViewerChromeIdle } from "@/hooks/use-viewer-chrome-idle";
import { IconButton } from "../viewer-chrome";
import type { VideoPlayback } from "./useVideoPlayback";
import {
  ChromeRegion,
  canSetVideoVolume,
  ElapsedClock,
  formatClock,
  formatSpeed,
  SeekTrack,
  SkipButton,
  SPEEDS,
  useFractionDrag,
  useOutsideClose,
  volumeIconFor,
} from "./video-player-controls";

type CapsulePanel = "settings" | "speed" | "volume";

export interface VideoPlayerChromeProps {
  chrome: Pick<ViewerChromeIdle, "chromeVisibilityClass" | "chromeVisible" | "revealChrome">;
  playback: VideoPlayback;
}

interface PlaybackProps {
  playback: VideoPlayback;
}

/**
 * The video-only controls: one low capsule holding transport, elapsed, timeline,
 * duration, volume and speed. Volume and speed open small panels straight up
 * from the capsule; phones fold both behind one cog. Title, file actions,
 * fullscreen, close and prev/next stay in the viewer's shared chrome.
 */
export function VideoPlayerChrome({ chrome, playback }: VideoPlayerChromeProps): JSX.Element {
  const [open, setOpen] = useState<CapsulePanel | null>(null);
  const [volumeSettable] = useState(canSetVideoVolume);
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  useOutsideClose(capsuleRef, open !== null, () => setOpen(null));
  const toggle = (which: CapsulePanel) => setOpen((current) => (current === which ? null : which));
  const fade = `transition-opacity duration-300 ${chrome.chromeVisibilityClass}`;
  const level = playback.muted ? 0 : playback.volume;

  return (
    <>
      {playback.holdBoosting ? (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 top-20 z-30 flex justify-center"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-sm font-semibold tabular-nums text-white ring-1 ring-white/15 backdrop-blur">
            <FastForward className="size-4 fill-current" /> 2×
          </span>
        </div>
      ) : null}

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 ${fade}`}
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <ChromeRegion
          className="w-full max-w-4xl"
          hidden={!chrome.chromeVisible}
          onReveal={chrome.revealChrome}
        >
          <div
            ref={capsuleRef}
            className="relative flex flex-wrap items-center gap-x-1 gap-y-0 rounded-3xl bg-zinc-900/65 px-2 py-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl sm:h-12 sm:flex-nowrap sm:rounded-full sm:px-3"
          >
            <div className="flex items-center gap-0.5">
              <SkipButton direction={-1} playback={playback} />
              <IconButton
                icon={playback.playing ? Pause : Play}
                label={playback.playing ? "Pause" : "Play"}
                onClick={playback.togglePlayback}
                size="md"
                fill
              />
              <SkipButton direction={1} playback={playback} />
            </div>
            <div className="order-last flex basis-full items-center gap-2 px-1 text-xs tabular-nums text-white/80 sm:order-none sm:basis-auto sm:flex-1">
              <ElapsedClock position={playback.position} />
              <SeekTrack playback={playback} />
              <span className="w-9 shrink-0 text-right">{formatClock(playback.duration)}</span>
            </div>
            <div className="ml-auto flex items-center gap-0.5 sm:ml-0">
              <div className="hidden items-center gap-0.5 sm:flex">
                {volumeSettable ? (
                  <Popup open={open === "volume"} panel={<VolumePanel playback={playback} />}>
                    <IconButton
                      active={open === "volume"}
                      icon={volumeIconFor(level)}
                      label="Volume"
                      onClick={() => toggle("volume")}
                      size="sm"
                    />
                  </Popup>
                ) : (
                  <MuteButton playback={playback} />
                )}
                <Popup
                  open={open === "speed"}
                  panel={
                    <SpeedList layout="column" onPick={() => setOpen(null)} playback={playback} />
                  }
                >
                  <button
                    type="button"
                    aria-label="Playback speed"
                    aria-expanded={open === "speed"}
                    title="Playback speed"
                    className={`inline-flex h-8 min-w-9 cursor-pointer items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-violet-400 ${playback.speed === 1 && open !== "speed" ? "text-white/90" : "text-violet-300"}`}
                    onClick={() => toggle("speed")}
                  >
                    {formatSpeed(playback.speed)}
                  </button>
                </Popup>
              </div>
              <div className="sm:hidden">
                <Popup
                  open={open === "settings"}
                  panel={<SettingsPanel playback={playback} volumeSettable={volumeSettable} />}
                  wide
                >
                  <IconButton
                    active={open === "settings" || playback.speed !== 1 || playback.muted}
                    icon={Settings}
                    label="Playback settings"
                    onClick={() => toggle("settings")}
                    size="sm"
                  />
                </Popup>
              </div>
            </div>
          </div>
        </ChromeRegion>
      </div>
    </>
  );
}

/** Anchors a panel straight up from its trigger; wide panels hug the capsule's right edge. */
function Popup({
  children,
  open,
  panel,
  wide = false,
}: {
  children: ReactNode;
  open: boolean;
  panel: ReactNode;
  wide?: boolean;
}): JSX.Element {
  return (
    // Phones anchor panels to the capsule's top edge; wider screens centre them on the trigger.
    <div className={wide ? "static" : "static sm:relative"}>
      {children}
      {open ? (
        <div
          className={`absolute bottom-full z-30 mb-3 rounded-2xl bg-zinc-900/90 shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl ${wide ? "right-2 sm:right-3" : "right-2 sm:left-1/2 sm:right-auto sm:-translate-x-1/2"}`}
        >
          {panel}
        </div>
      ) : null}
    </div>
  );
}

function volumeKeyDelta(key: string): number {
  if (key === "ArrowUp" || key === "ArrowRight") return 0.05;

  if (key === "ArrowDown" || key === "ArrowLeft") return -0.05;

  return 0;
}

const VOLUME_SLIDER = {
  x: {
    fill: "absolute inset-y-0 left-0 rounded-full bg-white",
    root: "flex h-8 flex-1 cursor-pointer items-center",
    thumb: "top-1/2 -translate-y-1/2",
    track: "h-1.5 w-full",
  },
  y: {
    fill: "absolute inset-x-0 bottom-0 rounded-full bg-white",
    root: "flex h-28 w-8 cursor-pointer justify-center",
    thumb: "left-1/2 translate-y-1/2",
    track: "h-full w-1.5",
  },
} as const;

/** The volume slider: vertical in the desktop panel, horizontal in the phone's settings. */
function VolumeSlider({ axis, playback }: PlaybackProps & { axis: "x" | "y" }): JSX.Element {
  const level = playback.muted ? 0 : playback.volume;
  const drag = useFractionDrag({ axis, onCommit: playback.setVolume, onScrub: playback.setVolume });
  const percent = `${level * 100}%`;
  const classes = VOLUME_SLIDER[axis];

  return (
    <div
      ref={drag.trackRef}
      {...drag.trackProps}
      role="slider"
      aria-label="Volume"
      aria-orientation={axis === "y" ? "vertical" : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      tabIndex={0}
      onKeyDown={(event) => {
        const delta = volumeKeyDelta(event.key);

        if (delta === 0) return;
        event.preventDefault();
        event.stopPropagation();
        playback.setVolume(playback.volume + delta);
      }}
      className={`${classes.root} outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-violet-400/70`}
    >
      <div className={`relative rounded-full bg-white/25 ${classes.track}`}>
        <div
          className={classes.fill}
          style={axis === "y" ? { height: percent } : { width: percent }}
        />
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute size-3.5 -translate-x-1/2 rounded-full bg-white shadow ${classes.thumb}`}
          style={axis === "y" ? { bottom: percent } : { left: percent }}
        />
      </div>
    </div>
  );
}

function VolumePanel({ playback }: PlaybackProps): JSX.Element {
  const level = playback.muted ? 0 : playback.volume;

  return (
    <div className="flex flex-col items-center gap-1 px-2 pb-1 pt-3">
      <VolumeSlider axis="y" playback={playback} />
      <span className="text-[11px] tabular-nums text-white/60">{Math.round(level * 100)}%</span>
      <MuteButton playback={playback} />
    </div>
  );
}

function MuteButton({ playback }: PlaybackProps): JSX.Element {
  return (
    <IconButton
      active={playback.muted}
      icon={volumeIconFor(playback.muted ? 0 : 1)}
      label={playback.muted ? "Unmute" : "Mute"}
      onClick={playback.toggleMute}
      size="sm"
    />
  );
}

/** The phone form of the volume control: speaker, level bar and percentage in one row. */
function VolumeRow({ playback }: PlaybackProps): JSX.Element {
  const level = playback.muted ? 0 : playback.volume;

  return (
    <div className="flex items-center gap-2">
      <IconButton
        active={playback.muted}
        icon={volumeIconFor(level)}
        label={playback.muted ? "Unmute" : "Mute"}
        onClick={playback.toggleMute}
        size="sm"
      />
      <VolumeSlider axis="x" playback={playback} />
      <span className="w-9 text-right text-[11px] tabular-nums text-white/60">
        {Math.round(level * 100)}%
      </span>
    </div>
  );
}

/**
 * The speed choices: a column, fastest first, in the desktop panel; a row of
 * pills in the phone's settings.
 */
function SpeedList({
  layout,
  onPick,
  playback,
}: PlaybackProps & { layout: "column" | "row"; onPick?: () => void }): JSX.Element {
  const speeds = layout === "column" ? [...SPEEDS].reverse() : SPEEDS;

  const buttons = speeds.map((speed) => {
    const current = speed === playback.speed;

    return (
      <button
        key={speed}
        type="button"
        aria-pressed={current}
        className={
          layout === "column"
            ? `cursor-pointer px-4 py-1.5 text-center text-sm tabular-nums transition hover:bg-white/10 ${current ? "font-semibold text-violet-300" : "text-white/90"}`
            : `h-8 flex-1 cursor-pointer rounded-full text-xs tabular-nums transition ${current ? "bg-violet-500/90 font-semibold text-white" : "bg-white/10 text-white/80 hover:bg-white/20"}`
        }
        onClick={() => {
          playback.setSpeed(speed);
          onPick?.();
        }}
      >
        {formatSpeed(speed)}
      </button>
    );
  });

  return layout === "column" ? (
    <fieldset aria-label="Playback speed" className="flex flex-col py-1">
      {buttons}
    </fieldset>
  ) : (
    <div role="radiogroup" aria-label="Playback speed" className="flex gap-1">
      {buttons}
    </div>
  );
}

/** Phone-only: volume and speed behind the cog; only mute where volume cannot be set. */
function SettingsPanel({
  playback,
  volumeSettable,
}: PlaybackProps & { volumeSettable: boolean }): JSX.Element {
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 p-4 text-sm">
      {volumeSettable ? <VolumeRow playback={playback} /> : <MuteButton playback={playback} />}
      <SpeedList layout="row" playback={playback} />
    </div>
  );
}
