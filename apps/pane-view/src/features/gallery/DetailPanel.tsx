import type { MediaItem } from "@latch-works/media-domain";
import { formatBytes } from "@latch-works/media-domain";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImageIcon,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteOverlay } from "./DeleteOverlay";
import { DEFAULT_CARD_WIDTH } from "./thumbnail-size";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

interface DetailPanelProps {
  isDeleted?: boolean;
  isDeleting?: boolean;
  onCopyPath: () => void;
  onDelete?: () => void;
  onDownload: () => void;
  onNext: () => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  onRegenerateThumbnail?: () => Promise<void>;
  selected: MediaItem | null;
  showDelete?: boolean;
}

export function DetailPanel({
  isDeleted = false,
  isDeleting = false,
  onCopyPath,
  onDelete,
  onDownload,
  onNext,
  onOpenViewer,
  onPrev,
  onRegenerateThumbnail,
  selected,
  showDelete = false,
}: DetailPanelProps) {
  const [thumbnailRefreshKey, setThumbnailRefreshKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const supportsThumbnail =
    selected?.mediaType === "image" ||
    selected?.mediaType === "gif" ||
    selected?.mediaType === "video";

  const preview = useResolvedMediaUrl({
    mediaId: selected?.id,
    refreshKey: thumbnailRefreshKey,
    size: DEFAULT_CARD_WIDTH,
    variant: "thumbnail",
  });
  const original = useResolvedMediaUrl({
    mediaId: preview.failed ? selected?.id : undefined,
    refreshKey: thumbnailRefreshKey,
    variant: "original",
  });
  const src = preview.resolvedUrl ?? original.resolvedUrl;
  const failed = !src && (preview.failed || original.failed);

  const handleRegenerateThumbnail = async () => {
    if (!onRegenerateThumbnail || regenerating) {
      return;
    }

    setRegenerating(true);
    try {
      await onRegenerateThumbnail();
      setThumbnailRefreshKey((current) => current + 1);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <aside
      className="h-full min-h-0 w-full overflow-y-auto overflow-x-hidden border-l border-border bg-background p-5"
      aria-label="Selected media"
    >
      {selected ? (
        <div className="grid min-w-0 max-w-full gap-4">
          <div className="relative grid aspect-[4/5] w-full min-w-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
            {src && !failed ? (
              <img alt={selected.name} className="h-full w-full object-cover" src={src} />
            ) : (
              <MediaPlaceholder mediaType={selected.mediaType} size={42} />
            )}
            {isDeleting || isDeleted ? (
              <DeleteOverlay animated={isDeleting} className="rounded-lg" />
            ) : null}
            {supportsThumbnail && onRegenerateThumbnail ? (
              <Button
                aria-label="Regenerate thumbnail"
                className="absolute right-2 top-2"
                disabled={regenerating}
                onClick={() => void handleRegenerateThumbnail()}
                size="icon"
                title="Regenerate thumbnail"
                type="button"
                variant="secondary"
              >
                <RefreshCw className={regenerating ? "size-4 animate-spin" : "size-4"} />
              </Button>
            ) : null}
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

          <div className="flex min-w-0 items-center gap-2">
            <Button className="min-w-0 flex-1" size="lg" variant="outline" onClick={onPrev} title="Previous" type="button">
              <ChevronLeft className="size-4" />
            </Button>
            <Button className="min-w-0 flex-1" size="lg" variant="outline" onClick={onNext} title="Next" type="button">
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="flex min-w-0 gap-2">
            <Button className="min-w-0 flex-1 gap-2" onClick={onCopyPath} type="button" variant="outline">
              <Copy className="size-4 shrink-0" />
              <span className="truncate">Copy path</span>
            </Button>
            <Button className="min-w-0 flex-1 gap-2" onClick={onDownload} type="button" variant="outline">
              <Download className="size-4 shrink-0" />
              <span className="truncate">Download</span>
            </Button>
          </div>

          {showDelete && onDelete ? (
            <Button
              className="w-full min-w-0 gap-2"
              disabled={isDeleting || isDeleted}
              onClick={onDelete}
              type="button"
              variant="destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          ) : null}

          <dl className="grid min-w-0 max-w-full gap-3 text-sm">
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
        <div className="grid min-h-96 place-items-center rounded-lg border border-dashed border-border text-center">
          <div className="grid max-w-56 justify-items-center gap-2 text-sm text-muted-foreground">
            <ImageIcon className="size-8" />
            <strong className="text-foreground">No media selected</strong>
            <span>Choose an image, video, or PDF from the browser.</span>
          </div>
        </div>
      )}
    </aside>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 max-w-full gap-1 border-b border-border pb-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 max-w-full overflow-hidden break-all font-medium text-foreground">{value}</dd>
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
