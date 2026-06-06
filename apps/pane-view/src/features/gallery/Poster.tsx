import type { MediaItem } from "@latch-works/media-domain";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildThumbnailRequestUrl } from "./thumbnail-size";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { readMediaPreviewUrl } from "./media-preview-url";
import { useThumbnailUrl } from "./useThumbnailUrl";

export function Poster({
  cardWidth = 220,
  media,
  priority = false,
}: {
  cardWidth?: number;
  media: MediaItem;
  priority?: boolean;
}) {
  const fallbackUrl = readMediaPreviewUrl(media);
  const requestUrl =
    media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video"
      ? buildThumbnailRequestUrl(media.id, cardWidth)
      : fallbackUrl;
  const { failed, loading, resolvedUrl } = useThumbnailUrl(requestUrl ?? fallbackUrl);
  const displayUrl = resolvedUrl ?? fallbackUrl;

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
