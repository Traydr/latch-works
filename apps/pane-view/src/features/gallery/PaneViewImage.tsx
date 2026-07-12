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
  readyUrl?: string;
  resolveMissing?: boolean;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

function resolveThumbnailPixelSize(width?: number): number {
  if (width && width > 0) {
    return Math.max(
      1,
      Math.round(width * (typeof window !== "undefined" ? window.devicePixelRatio : 1)),
    );
  }

  return GALLERY_THUMBNAIL_SIZE;
}

export function PaneViewImage({
  alt,
  className,
  height,
  layout: _layout = "constrained",
  mediaId,
  objectFit,
  priority = false,
  readyUrl,
  resolveMissing = true,
  variant = "thumbnail",
  width,
}: PaneViewImageProps) {
  const { failed, loading, resolvedUrl } = useResolvedMediaUrl({
    mediaId: resolveMissing || readyUrl ? mediaId : undefined,
    readyUrl,
    size: variant === "thumbnail" ? resolveThumbnailPixelSize(width) : undefined,
    variant,
  });

  if (!resolveMissing && !readyUrl) {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
  }

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
