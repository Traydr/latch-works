import type { MediaItem } from "@latch-works/media-domain";
import { ChevronLeft, ChevronRight, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaPlaceholder } from "./MediaPlaceholder";

interface DetailPanelProps {
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  selected: MediaItem | null;
}

function readThumbnailUrl(media: MediaItem): string | undefined {
  if (!("thumbnailUrl" in media) || typeof media.thumbnailUrl !== "string") {
    return undefined;
  }

  return media.thumbnailUrl;
}

export function DetailPanel({ onNext, onOpenViewer, onPrev, selected }: DetailPanelProps) {
  const thumbnailUrl = selected ? readThumbnailUrl(selected) : undefined;

  return (
    <aside
      className="hidden w-[360px] shrink-0 border-l border-zinc-800 bg-zinc-950 p-5 lg:block"
      aria-label="Selected media"
    >
      {selected ? (
        <div className="grid gap-4">
          <div className="grid aspect-[4/5] w-full place-items-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
            {thumbnailUrl ? (
              <img alt={selected.name} className="h-full w-full object-cover" src={thumbnailUrl} />
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
            <Button
              className="flex-1"
              size="lg"
              variant="outline"
              onClick={onPrev}
              title="Previous"
              type="button"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              className="flex-1"
              size="lg"
              variant="outline"
              onClick={onNext}
              title="Next"
              type="button"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <dl className="grid gap-3 text-sm">
            <MetadataItem label="Name" value={selected.name} />
            <MetadataItem label="Path" value={selected.path} />
            <MetadataItem label="Type" value={selected.mediaType} />
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
