import { GALLERY_THUMBNAIL_SIZE } from "@/features/gallery/gallery-thumbnail-size";
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
  previewReadyUrl?: string;
  readyUrl?: string;
  thumbnailReadyUrl?: string;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

export function PaneViewImage({
  alt,
  className,
  mediaId,
  objectFit,
  priority = false,
  previewReadyUrl,
  readyUrl,
  thumbnailReadyUrl,
  variant = "thumbnail",
}: PaneViewImageProps) {
  const resolvedReadyUrl =
    variant === "thumbnail"
      ? readyUrl ?? thumbnailReadyUrl
      : variant === "preview"
        ? readyUrl ?? previewReadyUrl
        : undefined;

  const { failed, loading, resolvedUrl } = useResolvedMediaUrl({
    fallbackReadyUrl: variant === "preview" ? thumbnailReadyUrl : undefined,
    mediaId,
    readyUrl: resolvedReadyUrl,
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
