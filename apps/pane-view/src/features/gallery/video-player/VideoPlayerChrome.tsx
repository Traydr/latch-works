import {
  Copy,
  Download,
  Info,
  Maximize,
  Minimize,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { type JSX, type ReactNode, useRef, useState } from "react";
import type { MediaViewerSessionModel } from "../MediaViewerSession";
import {
  ChromeRegion,
  formatClock,
  formatSpeed,
  IconButton,
  SeekTrack,
  SideChevrons,
  SkipButton,
  SPEEDS,
  useFractionDrag,
  useOutsideClose,
  useSeek,
  volumeIconFor,
} from "./video-player-controls";

type CapsulePanel = "info" | "settings" | "speed" | "volume";

export interface VideoPlayerChromeProps {
  model: MediaViewerSessionModel;
}

/**
 * The video player's controls: no top bar, one low capsule holding transport,
 * elapsed, timeline, duration and a row of glyphs on the right. Each glyph that
 * needs more (volume, speed, file details) opens a small panel straight up from
 * the capsule. Phones fold those three glyphs into one cog so the capsule stays
 * two rows tall.
 */
export function VideoPlayerChrome({ model }: VideoPlayerChromeProps): JSX.Element {
  const seek = useSeek(model);
  const [open, setOpen] = useState<CapsulePanel | null>(null);
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  useOutsideClose(capsuleRef, open !== null, () => setOpen(null));
  const toggle = (which: CapsulePanel) => setOpen((current) => (current === which ? null : which));
  const fade = `transition-opacity duration-300 ${model.chromeVisibilityClass}`;
  const level = model.muted ? 0 : model.volume;

  return (
    <>
      <SideChevrons model={model} />

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 ${fade}`}
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <ChromeRegion className="w-full max-w-4xl">
          <div
            ref={capsuleRef}
            className="relative flex flex-wrap items-center gap-x-1 gap-y-0 rounded-3xl bg-zinc-900/65 px-2 py-1 shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl sm:h-12 sm:flex-nowrap sm:rounded-full sm:px-3"
          >
            <div className="flex items-center gap-0.5">
              <IconButton
                className="md:hidden"
                disabled={!model.canStepBackward}
                icon={SkipBack}
                label="Previous item"
                onClick={() => model.onStep(-1)}
                size="sm"
                fill
              />
              <SkipButton direction={-1} model={model} />
              <IconButton
                icon={model.playing ? Pause : Play}
                label={model.playing ? "Pause" : "Play"}
                onClick={model.toggleVideoPlayback}
                size="md"
                fill
              />
              <SkipButton direction={1} model={model} />
              <IconButton
                className="md:hidden"
                disabled={!model.canStepForward}
                icon={SkipForward}
                label="Next item"
                onClick={() => model.onStep(1)}
                size="sm"
                fill
              />
            </div>
            <div className="order-last flex basis-full items-center gap-2 px-1 text-xs tabular-nums text-white/80 sm:order-none sm:basis-auto sm:flex-1">
              <span className="w-9 shrink-0">{formatClock(model.position)}</span>
              <SeekTrack seek={seek} />
              <span className="w-9 shrink-0 text-right">{formatClock(model.duration)}</span>
            </div>
            <div className="ml-auto flex items-center gap-0.5 sm:ml-0">
              <div className="hidden items-center gap-0.5 sm:flex">
                <Popup open={open === "volume"} panel={<VolumePanel model={model} />}>
                  <IconButton
                    active={open === "volume"}
                    icon={volumeIconFor(level)}
                    label="Volume"
                    onClick={() => toggle("volume")}
                    size="sm"
                  />
                </Popup>
                <Popup
                  open={open === "speed"}
                  panel={<SpeedPanel model={model} onPick={() => setOpen(null)} />}
                >
                  <button
                    type="button"
                    aria-label="Playback speed"
                    aria-haspopup="menu"
                    aria-expanded={open === "speed"}
                    title="Playback speed"
                    className={`inline-flex h-8 min-w-9 cursor-pointer items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-violet-400 ${model.speed === 1 && open !== "speed" ? "text-white/90" : "text-violet-300"}`}
                    onClick={() => toggle("speed")}
                  >
                    {formatSpeed(model.speed)}
                  </button>
                </Popup>
                <Popup open={open === "info"} panel={<InfoPanel model={model} />} wide>
                  <IconButton
                    active={open === "info"}
                    icon={Info}
                    label="File details"
                    onClick={() => toggle("info")}
                    size="sm"
                  />
                </Popup>
              </div>
              <div className="sm:hidden">
                <Popup open={open === "settings"} panel={<SettingsPanel model={model} />} wide>
                  <IconButton
                    active={open === "settings" || model.speed !== 1 || model.muted}
                    icon={Settings}
                    label="Playback settings"
                    onClick={() => toggle("settings")}
                    size="sm"
                  />
                </Popup>
              </div>
              <IconButton
                icon={model.isFullscreen ? Minimize : Maximize}
                label={model.isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                onClick={() => void model.toggleFullscreen()}
                size="sm"
              />
              <IconButton
                ref={model.closeButtonRef}
                icon={X}
                label="Close"
                onClick={model.onClose}
                size="sm"
              />
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

function VolumePanel({ model }: VideoPlayerChromeProps): JSX.Element {
  const level = model.muted ? 0 : model.volume;
  const drag = useFractionDrag({
    axis: "y",
    onCommit: model.changeVolume,
    onScrub: model.changeVolume,
  });
  const percent = `${level * 100}%`;
  return (
    <div className="flex flex-col items-center gap-1 px-2 pb-1 pt-3">
      <div
        ref={drag.trackRef}
        {...drag.trackProps}
        role="slider"
        aria-label="Volume"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        tabIndex={0}
        onKeyDown={(event) => {
          const delta = volumeKeyDelta(event.key);
          if (delta === 0) return;
          event.preventDefault();
          event.stopPropagation();
          model.changeVolume(model.volume + delta);
        }}
        className="flex h-28 w-8 cursor-pointer justify-center outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-violet-400/70"
      >
        <div className="relative h-full w-1.5 rounded-full bg-white/25">
          <div
            className="absolute inset-x-0 bottom-0 rounded-full bg-white"
            style={{ height: percent }}
          />
          <div
            className="absolute left-1/2 size-3.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-white shadow"
            style={{ bottom: percent }}
          />
        </div>
      </div>
      <span className="text-[11px] tabular-nums text-white/60">{Math.round(level * 100)}%</span>
      <IconButton
        active={model.muted}
        icon={volumeIconFor(model.muted ? 0 : 1)}
        label={model.muted ? "Unmute" : "Mute"}
        onClick={model.toggleMute}
        size="sm"
      />
    </div>
  );
}

/** The phone form of the volume control: speaker, level bar and percentage in one row. */
function VolumeRow({ model }: VideoPlayerChromeProps): JSX.Element {
  const level = model.muted ? 0 : model.volume;
  const drag = useFractionDrag({ onCommit: model.changeVolume, onScrub: model.changeVolume });
  const percent = `${level * 100}%`;
  return (
    <div className="flex items-center gap-2">
      <IconButton
        active={model.muted}
        icon={volumeIconFor(level)}
        label={model.muted ? "Unmute" : "Mute"}
        onClick={model.toggleMute}
        size="sm"
      />
      <div
        ref={drag.trackRef}
        {...drag.trackProps}
        role="slider"
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        tabIndex={0}
        onKeyDown={(event) => {
          const delta = volumeKeyDelta(event.key);
          if (delta === 0) return;
          event.preventDefault();
          event.stopPropagation();
          model.changeVolume(model.volume + delta);
        }}
        className="relative flex h-8 flex-1 cursor-pointer items-center outline-none focus-visible:[&>div:first-child]:ring-2 focus-visible:[&>div:first-child]:ring-violet-400/70"
      >
        <div className="relative h-1.5 w-full rounded-full bg-white/25">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white"
            style={{ width: percent }}
          />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
          style={{ left: percent }}
        />
      </div>
      <span className="w-9 text-right text-[11px] tabular-nums text-white/60">
        {Math.round(level * 100)}%
      </span>
    </div>
  );
}

function SpeedPanel({
  model,
  onPick,
}: VideoPlayerChromeProps & { onPick: () => void }): JSX.Element {
  return (
    <div role="menu" aria-label="Playback speed" className="flex flex-col py-1">
      {[...SPEEDS].reverse().map((speed) => (
        <button
          key={speed}
          type="button"
          role="menuitemradio"
          aria-checked={speed === model.speed}
          className={`cursor-pointer px-4 py-1.5 text-center text-sm tabular-nums transition hover:bg-white/10 ${speed === model.speed ? "font-semibold text-violet-300" : "text-white/90"}`}
          onClick={() => {
            model.applySpeed(speed);
            onPick();
          }}
        >
          {formatSpeed(speed)}
        </button>
      ))}
    </div>
  );
}

/** The phone form of the speed picker: one row of pills. */
function SpeedRow({ model }: VideoPlayerChromeProps): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Playback speed" className="flex gap-1">
      {SPEEDS.map((speed) => (
        <button
          key={speed}
          type="button"
          aria-pressed={speed === model.speed}
          className={`h-8 flex-1 cursor-pointer rounded-full text-xs tabular-nums transition ${speed === model.speed ? "bg-violet-500/90 font-semibold text-white" : "bg-white/10 text-white/80 hover:bg-white/20"}`}
          onClick={() => model.applySpeed(speed)}
        >
          {formatSpeed(speed)}
        </button>
      ))}
    </div>
  );
}

function FileDetails({ model }: VideoPlayerChromeProps): JSX.Element {
  return (
    <>
      <p className="break-all font-medium text-white">{model.item.name}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-white/70">
        <dt>Size</dt>
        <dd className="text-white/90">{model.details[0]}</dd>
        <dt>Format</dt>
        <dd className="text-white/90">{model.item.extension.toUpperCase()}</dd>
        <dt>Length</dt>
        <dd className="text-white/90">{formatClock(model.duration)}</dd>
        {model.item.width && model.item.height ? (
          <>
            <dt>Frame</dt>
            <dd className="text-white/90">
              {model.item.width}×{model.item.height}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          onClick={() => void model.copyPath()}
        >
          <Copy className="size-3.5" /> Copy path
        </button>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
          onClick={model.downloadMedia}
        >
          <Download className="size-3.5" /> Download
        </button>
      </div>
    </>
  );
}

function InfoPanel({ model }: VideoPlayerChromeProps): JSX.Element {
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] p-4 text-sm">
      <FileDetails model={model} />
    </div>
  );
}

/** Phone-only: volume, speed and file details behind the cog. */
function SettingsPanel({ model }: VideoPlayerChromeProps): JSX.Element {
  return (
    <div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 p-4 text-sm">
      <VolumeRow model={model} />
      <SpeedRow model={model} />
      <div className="border-t border-white/10 pt-4">
        <FileDetails model={model} />
      </div>
    </div>
  );
}
