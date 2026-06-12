import type { MediaItem } from "@latch-works/media-domain";
import { cn } from "@/lib/utils";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { PaneViewImage } from "./PaneViewImage";

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

  return (
    <div
      className={cn(
        "relative h-full w-full bg-zinc-800",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "pdf" && "text-red-300",
      )}
    >
      {supportsThumbnail ? (
        <PaneViewImage
          alt=""
          className="h-full w-full object-cover"
          layout="constrained"
          mediaId={media.id}
          objectFit="cover"
          priority={priority}
          variant="thumbnail"
          width={cardWidth}
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-zinc-500">
          <MediaPlaceholder mediaType={media.mediaType} size={28} />
        </div>
      )}
    </div>
  );
}
