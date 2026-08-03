import { Pause, Play } from 'lucide-react';
import type { JSX } from 'react';

interface ViewerVideoControlsProps {
  canSeek: boolean;
  chromeVisibilityClass: string;
  duration: number;
  onChangePosition: (position: number) => void;
  onChangeScrubbing: (scrubbing: boolean) => void;
  onChangeSpeed: (speed: number) => void;
  onChangeVolume: (volume: number) => void;
  onCommitSeek: (position: number) => void;
  onSkip: (seconds: number) => void;
  onTogglePlayback: () => void;
  playing: boolean;
  position: number;
  speed: number;
  volume: number;
}

export function ViewerVideoControls({
  canSeek,
  chromeVisibilityClass,
  duration,
  onChangePosition,
  onChangeScrubbing,
  onChangeSpeed,
  onChangeVolume,
  onCommitSeek,
  onSkip,
  onTogglePlayback,
  playing,
  position,
  speed,
  volume,
}: ViewerVideoControlsProps): JSX.Element {
  return (
    <div
      className={`viewer-scrim-bottom viewer-chrome-transition ${chromeVisibilityClass}`}
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="pointer-events-auto space-y-2">
        <input
          type="range"
          aria-label="Seek video"
          min={0}
          max={canSeek ? duration : 1}
          step={0.1}
          value={position}
          className="viewer-accent-range w-full"
          disabled={!canSeek}
          onPointerDown={() => onChangeScrubbing(true)}
          onPointerCancel={() => onChangeScrubbing(false)}
          onBlur={() => onChangeScrubbing(false)}
          onPointerUp={(event) => {
            if (!canSeek) {
              onChangeScrubbing(false);
              return;
            }

            onCommitSeek(Number(event.currentTarget.value));
            onChangeScrubbing(false);
          }}
          onInput={(event) => onChangePosition(Number(event.currentTarget.value))}
          onChange={(event) => {
            if (canSeek) {
              onCommitSeek(Number(event.target.value));
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm text-white/90">
          <button
            type="button"
            className="viewer-overlay-btn"
            title={playing ? 'Pause' : 'Play'}
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={onTogglePlayback}
          >
            {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
          </button>
          <button type="button" className="viewer-overlay-btn-text" onClick={() => onSkip(-5)}>
            -5s
          </button>
          <button type="button" className="viewer-overlay-btn-text" onClick={() => onSkip(5)}>
            +5s
          </button>
          <label className="flex items-center gap-2 text-white/80">
            Vol
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              className="viewer-accent-range"
              onChange={(event) => onChangeVolume(Number(event.target.value))}
            />
          </label>
          <label className="flex items-center gap-2 text-white/80">
            Speed
            <select
              className="rounded-lg border-0 bg-white/15 px-2 py-1 text-xs text-white outline-none"
              value={speed}
              onChange={(event) => onChangeSpeed(Number(event.target.value))}
            >
              <option value={0.5}>0.5x</option>
              <option value={1}>1x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
            </select>
          </label>
          <span className="text-white/70 tabular-nums">
            {Math.floor(position)}/{Math.floor(duration || 0)}s
          </span>
        </div>
      </div>
    </div>
  );
}
