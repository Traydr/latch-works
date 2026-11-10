import type { SettledDelivery } from "@/features/delivery/delivery-cache";
import { hasDeliverableRendition, THUMBNAIL_WIDTH } from "@/features/delivery/delivery-contract";
import { PaneViewImage } from "@/features/delivery/PaneViewImage";
import type { GalleryMedia } from "@/features/library/listing-contract";
import { cn } from "@/lib/utils";
import { MediaPlaceholder } from "./MediaPlaceholder";

/**
 * A tile's picture. The grid resolves thumbnails a window at a time, so the
 * tile shows an empty box until its batch answers, then the thumbnail, or the
 * media type's placeholder when no thumbnail can exist.
 */
export function Poster({
  media,
  priority = false,
  thumbnail,
}: {
  media: GalleryMedia;
  priority?: boolean;
  thumbnail?: SettledDelivery;
}) {
  const hasPicture =
    hasDeliverableRendition(media.mediaType) && thumbnail?.status !== "unavailable";

  return (
    <div
      className={cn(
        "relative h-full w-full bg-zinc-800",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "pdf" && "text-red-300",
      )}
    >
      {!hasPicture ? (
        <div className="grid h-full w-full place-items-center text-zinc-500">
          <MediaPlaceholder mediaType={media.mediaType} size={28} />
        </div>
      ) : thumbnail?.status === "ready" ? (
        <PaneViewImage
          alt=""
          className="h-full w-full object-cover"
          mediaId={media.id}
          objectFit="cover"
          priority={priority}
          readyUrl={thumbnail.url}
          revision={media.sha256}
          variant="thumbnail"
          width={THUMBNAIL_WIDTH}
        />
      ) : (
        <div aria-hidden className="h-full w-full bg-zinc-800/80" />
      )}
    </div>
  );
}
