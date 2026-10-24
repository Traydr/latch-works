import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDuration } from "../lib/format";

interface Playback {
  paused: boolean;
  muted: boolean;
  time: number;
  duration: number;
}

const EVENTS = ["play", "pause", "timeupdate", "volumechange", "durationchange", "ended"] as const;

function playbackOf(video: HTMLVideoElement): Playback {
  return {
    paused: video.paused,
    muted: video.muted,
    time: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
  };
}

/**
 * Play, pause, a scrubber and sound for one video, drawn over its picture, so versions can be
 * watched and heard side by side to check their length and soundtrack. Clicks stay here: the
 * tile under it keeps a version on click, which these must not do.
 */
export function VideoControls({
  video,
  shown,
  className = "",
}: {
  video: HTMLVideoElement | null;
  /** Shown while playing; otherwise only on hover, through `shown` or the parent's group. */
  shown?: boolean;
  className?: string;
}) {
  const [playback, setPlayback] = useState<Playback>({
    paused: true,
    muted: false,
    time: 0,
    duration: 0,
  });

  useEffect(() => {
    if (!video) {
      return;
    }

    const update = () => setPlayback(playbackOf(video));

    for (const name of EVENTS) {
      video.addEventListener(name, update);
    }

    update();

    return () => {
      for (const name of EVENTS) {
        video.removeEventListener(name, update);
      }
    };
  }, [video]);

  if (!video) {
    return null;
  }

  const visible = shown || !playback.paused ? "opacity-100" : "opacity-0 group-hover:opacity-100";

  return (
    // biome-ignore lint/a11y: it only keeps its clicks from reaching the tile, which keeps a version on click; its buttons take the keyboard.
    <div
      className={`dark flex items-center gap-1.5 rounded-lg bg-black/65 px-1.5 py-1 text-white backdrop-blur-sm transition-opacity duration-150 ${visible} ${className}`}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-white/15"
        aria-label={playback.paused ? "Play" : "Pause"}
        title={playback.paused ? "Play" : "Pause"}
        onClick={() => (video.paused ? void video.play().catch(() => undefined) : video.pause())}
      >
        {playback.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
      </button>
      <span className="shrink-0 text-xs tabular-nums">
        {formatDuration(playback.time * 1000)} / {formatDuration(playback.duration * 1000)}
      </span>
      <input
        type="range"
        aria-label="Position"
        tabIndex={-1}
        min={0}
        max={playback.duration || 1}
        step={0.05}
        value={playback.time}
        onChange={(event) => {
          video.currentTime = Number(event.target.value);
        }}
        className="h-1 min-w-0 flex-1 accent-violet-400"
      />
      <button
        type="button"
        className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-white/15"
        aria-label={playback.muted ? "Sound on" : "Sound off"}
        title={playback.muted ? "Sound on" : "Sound off"}
        onClick={() => {
          video.muted = !video.muted;
        }}
      >
        {playback.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
    </div>
  );
}
