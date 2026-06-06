import type { MediaItem } from "@latch-works/media-domain";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { buildThumbnailRequestUrl } from "./thumbnail-size";
import { MediaPlaceholder } from "./MediaPlaceholder";
import { readMediaPreviewUrl } from "./media-preview-url";

export function Poster({
  cardWidth = 220,
  media,
  priority = false,
}: {
  cardWidth?: number;
  media: MediaItem;
  priority?: boolean;
}) {
  const previewUrl = readMediaPreviewUrl(media);
  const primaryUrl =
    previewUrl ??
    (media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video"
      ? buildThumbnailRequestUrl(media.id, cardWidth)
      : undefined);
  const originalUrl = `/api/media/${media.id}/original`;
  const canFallbackToOriginal =
    media.mediaType === "image" || media.mediaType === "gif" || media.mediaType === "video";

  const [src, setSrc] = useState(primaryUrl);
  const [loading, setLoading] = useState(Boolean(primaryUrl));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(primaryUrl);
    setLoading(Boolean(primaryUrl));
    setFailed(false);
  }, [media.id, primaryUrl]);

  return (
    <div
      className={cn(
        "relative h-full w-full bg-zinc-800",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "pdf" && "text-red-300",
      )}
    >
      {loading ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      {src && !failed ? (
        <img
          alt=""
          className={cn("h-full w-full object-cover", loading && "opacity-0")}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          loading={priority ? "eager" : "lazy"}
          onError={() => {
            if (canFallbackToOriginal && src !== originalUrl) {
              setSrc(originalUrl);
              setLoading(true);
              return;
            }

            setFailed(true);
            setLoading(false);
          }}
          onLoad={() => setLoading(false)}
          src={src}
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-zinc-500">
          <MediaPlaceholder mediaType={media.mediaType} size={28} />
        </div>
      )}
    </div>
  );
}
