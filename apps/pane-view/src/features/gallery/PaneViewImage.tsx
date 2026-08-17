import { ImageOff } from "lucide-react";
import { GALLERY_THUMBNAIL_SIZE } from "@/features/gallery/gallery-thumbnail-size";
import { cn } from "@/lib/utils";
import { useImageLoadRetry } from "./useImageLoadRetry";
import { type ResolvedMediaUrlCache, useResolvedMediaUrl } from "./useResolvedMediaUrl";

type PaneViewImageProps = {
  alt: string;
  /** Overrides the shared URL cache; tests inject a cache with a fake resolver. */
  cache?: ResolvedMediaUrlCache;
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
    const devicePixelRatio = "window" in globalThis ? window.devicePixelRatio : 1;
    return Math.max(1, Math.round(width * devicePixelRatio));
  }

  return GALLERY_THUMBNAIL_SIZE;
}

/**
 * Renders one media rendition and keeps trying when the load fails. Shutter
 * builds image renditions on first request, so a burst of cold tiles can be
 * answered with 503s that would otherwise sit as broken images until the page
 * reloads. Failed loads retry on a jittered backoff; a persistent failure also
 * re-resolves the URL in case the cached one expired; only after the whole
 * schedule does the tile settle into the failed state.
 */
export function PaneViewImage({
  alt,
  cache,
  className,
  layout: _layout = "constrained",
  mediaId,
  objectFit,
  priority = false,
  readyUrl,
  resolveMissing = true,
  variant = "thumbnail",
  width,
}: PaneViewImageProps) {
  const size = variant === "thumbnail" ? resolveThumbnailPixelSize(width) : undefined;
  const canResolve = resolveMissing || Boolean(readyUrl);
  const retry = useImageLoadRetry(`${mediaId}:${variant}:${size ?? "default"}:${readyUrl ?? ""}`);
  const { failed, loading, resolvedUrl } = useResolvedMediaUrl({
    cache,
    mediaId: canResolve ? mediaId : undefined,
    readyUrl: retry.shouldRefreshUrl ? undefined : readyUrl,
    refreshKey: retry.shouldRefreshUrl ? 1 : 0,
    size,
    variant,
  });

  if (!canResolve || loading || !resolvedUrl || retry.phase === "waiting") {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
  }

  if (failed || retry.phase === "failed") {
    return (
      <div
        aria-hidden
        className={cn(className, "grid place-items-center bg-zinc-800 text-zinc-600")}
      >
        <ImageOff size={20} />
      </div>
    );
  }

  return (
    <img
      key={retry.failures}
      alt={alt}
      className={className}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      loading={priority ? "eager" : "lazy"}
      onError={retry.onError}
      src={resolvedUrl}
      style={objectFit ? { objectFit } : undefined}
    />
  );
}
