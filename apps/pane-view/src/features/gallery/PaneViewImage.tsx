import { GALLERY_THUMBNAIL_SIZE } from "@latch-works/media-delivery";
import { cn } from "@/lib/utils";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

type PaneViewImageProps = {
  alt: string;
  className?: string;
  height?: number;
  layout?: "fixed" | "constrained" | "fullWidth";
  mediaId: string;
  objectFit?: "contain" | "cover" | "fill" | "none" | "scale-down";
  priority?: boolean;
  readyUrl?: string;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

export function PaneViewImage({
  alt,
  className,
  mediaId,
  objectFit,
  priority = false,
  readyUrl,
  variant = "thumbnail",
}: PaneViewImageProps) {
  const { failed, loading, resolvedUrl } = useResolvedMediaUrl({
    mediaId,
    readyUrl: variant === "thumbnail" ? readyUrl : undefined,
    // Gallery tiles use a single fixed size so generated derivatives always
    // match the size the snapshot embeds; preview/original ignore size.
    size: variant === "thumbnail" ? GALLERY_THUMBNAIL_SIZE : undefined,
    variant,
  });

  if (loading || !resolvedUrl) {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
  }

  if (failed) {
    return <div aria-hidden className={cn(className, "bg-zinc-800")} />;
  }

  return (
    <img
      alt={alt}
      className={className}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      loading={priority ? "eager" : "lazy"}
      src={resolvedUrl}
      style={objectFit ? { objectFit } : undefined}
    />
  );
}
