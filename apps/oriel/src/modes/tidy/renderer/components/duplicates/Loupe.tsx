import type { FileFormat, FileId, FileRow } from "@latch-works/glazier-core/contract";
import { Check, FolderOpen, Images, X } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useDarkScreen } from "../../../../../shell/window-surface";
import { desktop, mediaUrl, thumbnailUrl } from "../../lib/api";
import { useOpenInView } from "../../lib/hand-off";
import { Thumbnail } from "../media";
import { VideoControls } from "../VideoControls";
import { factsOf, type SetRow } from "./model";

/** Formats Chromium draws itself, so the loupe shows the file's own pixels. */
const BROWSER_FORMATS = new Set<FileFormat>(["jpeg", "png", "gif", "webp", "avif", "bmp", "svg"]);

function canShow(file: FileRow): boolean {
  return (file.kind === "image" || file.kind === "video") && file.probeError === null;
}

/** The file itself where Chromium can draw it, so a 4000 px original is not judged at 1024 px. */
function sourceOf(file: FileRow): string {
  return file.format !== null && BROWSER_FORMATS.has(file.format)
    ? mediaUrl(file.absPath)
    : thumbnailUrl(file.absPath, 1024);
}

/**
 * One version at a time over the whole window, as Lightroom's Loupe and FastRawViewer are used
 * for culling: ← and → (or ‹ ›) flip between versions drawn in the same place at the same size,
 * so a difference jumps out. Every version is loaded at once and only shown or hidden, so a flip
 * never blinks. A click on the picture (or Z) shows actual size at that point, and the pan is
 * kept across flips; every version is drawn at the largest one's width there, so the same region
 * stays in view. The decision bar sits over it.
 */
export function Loupe({
  rows,
  index,
  kept,
  closeCall,
  suggested,
  zoomed,
  playing,
  soundOn,
  pointer,
  onClose,
  onToggleZoom,
  children,
}: {
  rows: readonly SetRow[];
  index: number;
  kept: ReadonlySet<FileId>;
  closeCall: boolean;
  /** The number of the suggested (or first kept) version, for when another one is shown. */
  suggested: number;
  zoomed: boolean;
  playing: boolean;
  soundOn: boolean;
  /** Where to zoom in, as fractions of the picture, or null for its centre. */
  pointer: { x: number; y: number } | null;
  onClose: () => void;
  onToggleZoom: (at: { x: number; y: number }) => void;
  /** The decision bar, drawn over the loupe. */
  children: ReactNode;
}) {
  const openInView = useOpenInView();
  useDarkScreen();
  const row = rows[index];
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const keeper = rows.find((candidate) => kept.has(candidate.file.id))?.file ?? rows[0]?.file;
  const width = Math.max(...rows.map((candidate) => candidate.file.width ?? 0)) || undefined;

  // Entering actual size centres the chosen point; flipping keeps the pan as it is.
  useLayoutEffect(() => {
    const element = stage.current;

    if (!element || !zoomed) {
      return;
    }

    const at = pointer ?? { x: 0.5, y: 0.5 };

    element.scrollLeft = at.x * element.scrollWidth - element.clientWidth / 2;
    element.scrollTop = at.y * element.scrollHeight - element.clientHeight / 2;
  }, [zoomed, pointer]);

  useEffect(() => {
    const element = video.current;

    if (!element) {
      return;
    }

    if (playing) {
      void element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, [playing]);

  if (!row || !keeper) {
    return null;
  }

  const { file } = row;
  const isKept = kept.has(file.id);
  const facts = factsOf(file, keeper);

  /** The point clicked, as fractions of the picture, to zoom in (or out) there. */
  const zoomAt = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();

    onToggleZoom({
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    });
  };

  const fitted = rows.map((candidate, position) =>
    canShow(candidate.file) && candidate.file.kind === "image" ? (
      // biome-ignore lint/a11y: a click on the picture zooms, as in Lightroom's Loupe; Z does the same from the keyboard.
      <img
        key={candidate.file.id}
        src={sourceOf(candidate.file)}
        alt=""
        draggable={false}
        onClick={zoomAt}
        style={{ visibility: position === index ? "visible" : "hidden" }}
        className="absolute inset-0 h-full w-full cursor-zoom-in object-contain"
      />
    ) : null,
  );

  const current = !canShow(file) ? (
    <div className="absolute inset-0 flex items-center justify-center">
      <Thumbnail row={file} size={96} />
    </div>
  ) : file.kind === "video" ? (
    <video
      ref={(element) => {
        video.current = element;
        setVideoElement(element);
      }}
      key={file.id}
      src={mediaUrl(file.absPath)}
      poster={thumbnailUrl(file.absPath, 1024)}
      muted={!soundOn}
      loop
      playsInline
      preload="metadata"
      style={zoomed && width ? { width, maxWidth: "none" } : undefined}
      className={zoomed ? "block" : "absolute inset-0 h-full w-full object-contain"}
    />
  ) : zoomed ? (
    // biome-ignore lint/a11y: a click on the picture zooms back out; Z does the same from the keyboard.
    <img
      key={file.id}
      src={sourceOf(file)}
      alt=""
      draggable={false}
      onClick={zoomAt}
      style={width ? { width, maxWidth: "none" } : undefined}
      className="block cursor-zoom-out"
    />
  ) : null;

  return (
    // Always dark, as Frame View's viewer, Quick Look and Lightroom are, so a photo is judged on
    // a neutral surround in either theme.
    <div className="dark lw-enter-fade fixed inset-0 z-40 flex flex-col bg-zinc-950 text-zinc-100">
      <div
        className={`lw-drag flex h-[52px] shrink-0 items-center gap-3 pr-[calc(0.75rem+var(--lw-window-controls))] ${
          desktop.insetTitleBar() ? "pl-[84px]" : "pl-5"
        }`}
      >
        <span className="lw-badge lw-badge-neutral min-w-12 shrink-0 justify-center">
          {index + 1} of {rows.length}
        </span>
        {isKept ? (
          closeCall ? (
            <span className="lw-badge shrink-0 bg-white/10 text-white">Suggested</span>
          ) : (
            <span className="lw-badge lw-badge-keep shrink-0">
              <Check className="size-3.5" /> Keep
            </span>
          )
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium" title={file.relPath}>
            {file.relPath}
          </span>
          <span className="lw-caption block truncate">
            {facts.map((fact, position) => (
              <span key={fact.text}>
                {position > 0 ? " · " : ""}
                <span className={fact.worse ? "font-medium text-amber-300" : ""}>{fact.text}</span>
              </span>
            ))}
            {isKept ? null : ` · Suggested: ${suggested}`}
          </span>
        </span>
        <span className="lw-caption hidden shrink-0 lg:inline">
          ← → flip · 1–{rows.length} or ↩ keep · Z or click: actual size
        </span>
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-icon shrink-0"
          title="Show in Finder  ⇧⌘R"
          aria-label="Show in Finder"
          onClick={() => void desktop.reveal(file.absPath)}
        >
          <FolderOpen />
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-icon shrink-0"
          title="Open in View"
          aria-label="Open in View"
          onClick={() => openInView(file.absPath)}
        >
          <Images />
        </button>
        <button
          type="button"
          className="lw-btn lw-btn-ghost lw-btn-icon shrink-0"
          title="Back to the grid  Esc"
          aria-label="Back to the grid"
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      <div
        ref={stage}
        className={`relative min-h-0 flex-1 ${zoomed ? "overflow-auto" : "mx-5 mb-[76px] overflow-hidden"}`}
      >
        {zoomed ? null : fitted}
        {current}
      </div>

      {file.kind === "video" && canShow(file) ? (
        <VideoControls
          video={videoElement}
          shown
          className="absolute bottom-[84px] left-1/2 w-[min(560px,calc(100%-40px))] -translate-x-1/2"
        />
      ) : null}

      {children}
    </div>
  );
}
