import type { MediaItem } from "@latch-works/media-domain";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { resolveRequestedThumbnailSize } from "./thumbnail-size";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

export function Poster({
  cardWidth = 220,
  media,
  priority = false,
}: {
  cardWidth?: number;
  media: MediaItem;
  priority?: boolean;
}) {
  const supportsThumbnail =
    media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video";
  const thumbnailSize = resolveRequestedThumbnailSize(cardWidth);
  const thumbnail = useResolvedMediaUrl({
    mediaId: supportsThumbnail ? media.id : undefined,
    size: thumbnailSize,
    variant: "thumbnail",
  });
  const original = useResolvedMediaUrl({
    mediaId: supportsThumbnail && thumbnail.failed ? media.id : undefined,
    variant: "original",
  });
  const displayUrl = thumbnail.resolvedUrl ?? original.resolvedUrl;
  const loading = thumbnail.loading || original.loading;
  const failed = !displayUrl && (thumbnail.failed || original.failed);

  return (
    <div
      className={cn(
        "relative h-full w-full bg-zinc-800",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "pdf" && "text-red-300",
      )}
    >
      {loading ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      {displayUrl && !failed ? (
        <img
          alt=""
          className={cn("h-full w-full object-cover", loading && "opacity-0")}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          loading={priority ? "eager" : "lazy"}
          onLoad={() => undefined}
          src={displayUrl}
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-zinc-500">
          <MediaPlaceholder mediaType={media.mediaType} size={28} />
        </div>
      )}
    </div>
  );
}
