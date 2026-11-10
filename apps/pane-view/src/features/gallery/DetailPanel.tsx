import { formatBytes } from "@latch-works/media-domain";
import { ChevronLeft, ChevronRight, Download, FolderOpen, ImageIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasDeliverableRendition, PREVIEW_CSS_WIDTH } from "@/features/delivery/delivery-contract";
import { PaneViewImage } from "@/features/delivery/PaneViewImage";
import { devicePixelWidth } from "@/features/delivery/useDeliveryUrl";
import type { GalleryMedia } from "@/features/library/listing-contract";
import { COPY_PATH_ICONS, COPY_PATH_LABELS } from "@/hooks/copy-path-status";
import type { CopyStatus } from "@/hooks/use-copy-to-clipboard";
import { DeleteOverlay } from "./DeleteOverlay";
import { MediaPlaceholder } from "./MediaPlaceholder";

interface DetailPanelProps {
  copyStatus: CopyStatus;
  deleteError?: string | null;
  isDeleted?: boolean;
  isDeleting?: boolean;
  onCopyPath: () => void;
  onDelete?: () => void;
  onDownload: () => void;
  onNext: () => void;
  onNavigateToPath: (path: string) => void;
  onOpenViewer: () => void;
  onPrev: () => void;
  selected: GalleryMedia | null;
  showDelete?: boolean;
}

export function DetailPanel({
  copyStatus,
  deleteError = null,
  isDeleted = false,
  isDeleting = false,
  onCopyPath,
  onDelete,
  onDownload,
  onNext,
  onNavigateToPath,
  onOpenViewer,
  onPrev,
  selected,
  showDelete = false,
}: DetailPanelProps) {
  const CopyIcon = COPY_PATH_ICONS[copyStatus];

  const supportsThumbnail = selected !== null && hasDeliverableRendition(selected.mediaType);

  return (
    <aside
      className="h-full min-h-0 w-full overflow-y-auto overflow-x-hidden border-l border-border bg-background p-5"
      aria-label="Selected media"
    >
      {selected ? (
        <div className="grid min-w-0 max-w-full gap-4">
          <div className="relative grid aspect-[4/5] w-full min-w-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
            {supportsThumbnail ? (
              <PaneViewImage
                alt={selected.name}
                className="h-full w-full object-cover"
                mediaId={selected.id}
                objectFit="cover"
                revision={selected.sha256}
                variant="preview"
                width={devicePixelWidth(PREVIEW_CSS_WIDTH.detailPanel)}
              />
            ) : (
              <MediaPlaceholder mediaType={selected.mediaType} size={42} />
            )}
            {isDeleting || isDeleted ? (
              <DeleteOverlay animated={isDeleting} className="rounded-lg" />
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
            <Button
              className="min-w-0 flex-1"
              size="lg"
              variant="outline"
              onClick={onPrev}
              title="Previous"
              type="button"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              className="min-w-0 flex-1"
              size="lg"
              variant="outline"
              onClick={onNext}
              title="Next"
              type="button"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="flex min-w-0 gap-2">
            <Button
              className="min-w-0 flex-1 gap-2"
              onClick={onCopyPath}
              type="button"
              variant="outline"
            >
              <CopyIcon className="size-4 shrink-0" />
              <span className="truncate">{COPY_PATH_LABELS[copyStatus]}</span>
            </Button>
            <span aria-live="polite" className="sr-only">
              {copyStatus === "idle" ? "" : COPY_PATH_LABELS[copyStatus]}
            </span>
            <Button
              className="min-w-0 flex-1 gap-2"
              onClick={onDownload}
              type="button"
              variant="outline"
            >
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
          {showDelete && deleteError ? (
            <p className="text-sm text-destructive">{deleteError}</p>
          ) : null}

          <dl className="grid min-w-0 max-w-full gap-3 text-sm">
            <MetadataItem label="Name" value={selected.name} />
            <div className="grid min-w-0 gap-2 border-b border-border pb-3">
              <dt className="text-xs text-muted-foreground">Path</dt>
              <dd className="m-0 grid min-w-0 gap-2">
                <span className="break-all font-medium text-foreground">{selected.path}</span>
                <Button
                  className="w-full gap-2"
                  disabled={isDeleting || isDeleted}
                  onClick={() => onNavigateToPath(selected.parentPath)}
                  size="sm"
                  title={selected.parentPath || "Archive root"}
                  type="button"
                  variant="outline"
                >
                  <FolderOpen className="size-4 shrink-0" />
                  Open parent folder
                </Button>
              </dd>
            </div>
            <MetadataItem label="Type" value={selected.mediaType} />
            <MetadataItem label="Size" value={formatBytes(selected.size)} />
            <MetadataItem label="Modified" value={formatModified(selected.mtimeMs)} />
          </dl>
        </div>
      ) : (
        <div className="grid min-h-96 place-items-center rounded-lg border border-dashed border-border text-center">
          <div className="grid max-w-56 justify-items-center gap-2 text-sm text-muted-foreground">
            <ImageIcon className="size-8" />
            <strong className="text-foreground">No media selected</strong>
            <span className="text-pretty">Choose an image, video, or PDF from the browser.</span>
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
      <dd className="m-0 max-w-full overflow-hidden break-all font-medium text-foreground">
        {value}
      </dd>
    </div>
  );
}

function formatModified(mtimeMs: number): string {
  return new Date(mtimeMs).toLocaleString();
}
