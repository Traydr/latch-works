import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import { ChevronLeft, ChevronRight, Copy, Download, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_CARD_WIDTH } from "./thumbnail-size";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

interface DetailPanelProps {
  onCopyPath: () => void;
  onDownload: () => void;
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  selected: MediaItem | null;
}

export function DetailPanel({
  onCopyPath,
  onDownload,
  onNext,
  onOpenViewer,
  onPrev,
  selected,
}: DetailPanelProps) {
  const preview = useResolvedMediaUrl({
    mediaId: selected?.id,
    size: DEFAULT_CARD_WIDTH,
    variant: "thumbnail",
  });
  const original = useResolvedMediaUrl({
    mediaId: preview.failed ? selected?.id : undefined,
    variant: "original",
  });
  const src = preview.resolvedUrl ?? original.resolvedUrl;
  const failed = !src && (preview.failed || original.failed);

  return (
    <aside
      className="hidden h-full min-h-0 w-full max-w-[360px] shrink-0 overflow-y-auto overflow-x-hidden border-l border-zinc-800 bg-zinc-950 p-5 lg:block"
      aria-label="Selected media"
    >
      {selected ? (
        <div className="grid gap-4">
          <div className="grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
            {src && !failed ? (
              <img alt={selected.name} className="h-full w-full object-cover" src={src} />
            ) : (
              <MediaPlaceholder mediaType={selected.mediaType} size={42} />
            )}
          </div>

          <Button
            className="w-full"
            onClick={onOpenViewer}
            size="lg"
            type="button"
            variant="default"
          >
            Open Viewer
          </Button>

          <div className="flex items-center gap-2">
            <Button className="flex-1" size="lg" variant="outline" onClick={onPrev} title="Previous" type="button">
              <ChevronLeft className="size-4" />
            </Button>
            <Button className="flex-1" size="lg" variant="outline" onClick={onNext} title="Next" type="button">
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="flex gap-2">
            <Button className="flex-1 gap-2" onClick={onCopyPath} type="button" variant="outline">
              <Copy className="size-4" />
              Copy path
            </Button>
            <Button className="flex-1 gap-2" onClick={onDownload} type="button" variant="outline">
              <Download className="size-4" />
              Download
            </Button>
          </div>

          <dl className="grid gap-3 text-sm">
            <MetadataItem label="Name" value={selected.name} />
            <MetadataItem label="Path" value={selected.path} />
            <MetadataItem label="Type" value={selected.mediaType} />
            <MetadataItem label="Size" value={formatBytes(selected.size)} />
            {selected.width && selected.height ? (
              <MetadataItem label="Dimensions" value={`${selected.width}×${selected.height}`} />
            ) : null}
            {selected.durationMs ? (
              <MetadataItem label="Duration" value={formatDuration(selected.durationMs)} />
            ) : null}
            <MetadataItem label="Modified" value={formatModified(selected.mtimeMs)} />
          </dl>
        </div>
      ) : (
        <div className="grid min-h-96 place-items-center rounded-lg border border-dashed border-zinc-800 text-center">
          <div className="grid max-w-56 justify-items-center gap-2 text-sm text-zinc-400">
            <ImageIcon className="size-8" />
            <strong className="text-zinc-100">No media selected</strong>
            <span>Choose an image, video, or PDF from the browser.</span>
          </div>
        </div>
      )}
    </aside>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-zinc-800 pb-3">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="m-0 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatModified(mtimeMs: number): string {
  return new Date(mtimeMs).toLocaleString();
}
