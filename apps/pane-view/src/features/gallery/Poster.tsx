import type { MediaItem } from "@latch-works/media-domain";
import { cn } from "@/lib/utils";
import { MediaPlaceholder } from "./MediaPlaceholder";

function readThumbnailUrl(media: MediaItem): string | undefined {
  if (!("thumbnailUrl" in media) || typeof media.thumbnailUrl !== "string") {
    return undefined;
  }

  return media.thumbnailUrl;
}

export function Poster({ media }: { media: MediaItem }) {
  const thumbnailUrl = readThumbnailUrl(media);

  return (
    <div
      className={cn(
        "relative h-full w-full bg-zinc-800",
        media.mediaType === "video" && "text-emerald-300",
        media.mediaType === "pdf" && "text-red-300",
      )}
    >
      {thumbnailUrl ? (
        <img alt="" className="h-full w-full object-cover" loading="lazy" src={thumbnailUrl} />
      ) : (
        <div className="grid h-full w-full place-items-center text-zinc-500">
          <MediaPlaceholder mediaType={media.mediaType} size={28} />
        </div>
      )}
    </div>
  );
}
