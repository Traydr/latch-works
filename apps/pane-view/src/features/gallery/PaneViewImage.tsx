import { Image } from "@unpic/react";
import { GALLERY_THUMBNAIL_SIZE } from "@/features/gallery/gallery-thumbnail-size";
import {
  buildBunnyLwImageSrc,
  readClientImageDeliveryMode,
} from "@/env/image-delivery-client";
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
  resolveMissing?: boolean;
  thumbnailDeliveryToken?: string;
  thumbnailReadyUrl?: string;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

function resolveThumbnailPixelSize(width?: number): number {
  if (width && width > 0) {
    return Math.max(1, Math.round(width * (typeof window !== "undefined" ? window.devicePixelRatio : 1)));
  }

  return GALLERY_THUMBNAIL_SIZE;
}

export function PaneViewImage({
  alt,
  className,
  height,
  layout = "constrained",
  mediaId,
  objectFit,
  priority = false,
  previewReadyUrl,
  readyUrl,
  resolveMissing = true,
  thumbnailDeliveryToken,
  thumbnailReadyUrl,
  variant = "thumbnail",
  width,
}: PaneViewImageProps) {
  const resolvedReadyUrl =
    variant === "thumbnail"
      ? (readyUrl ?? thumbnailReadyUrl)
      : variant === "preview"
        ? (readyUrl ?? previewReadyUrl)
        : undefined;

  const resolvedReadyDeliveryToken =
    variant === "thumbnail" ? thumbnailDeliveryToken : undefined;

  const { deliveryToken, failed, loading, resolvedUrl } = useResolvedMediaUrl({
    deliveryToken: resolvedReadyDeliveryToken,
    fallbackReadyUrl: variant === "preview" ? thumbnailReadyUrl : undefined,
    mediaId: resolveMissing || resolvedReadyUrl || resolvedReadyDeliveryToken ? mediaId : undefined,
    readyUrl: resolvedReadyUrl,
    size: variant === "thumbnail" ? resolveThumbnailPixelSize(width) : undefined,
    variant,
  });

  if (!resolveMissing && !resolvedReadyUrl && !resolvedReadyDeliveryToken) {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
  }

  if (loading || (!resolvedUrl && !deliveryToken)) {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
  }

  if (failed) {
    return <div aria-hidden className={cn(className, "bg-zinc-800")} />;
  }

  const imageWidth = resolveThumbnailPixelSize(width);
  const imageHeight = height ?? imageWidth;
  const useBunny = variant === "thumbnail" && readClientImageDeliveryMode() === "bunny";
  const unpicLayout = layout === "fullWidth" ? "constrained" : layout;

  if (useBunny && deliveryToken) {
    return (
      <Image
        alt={alt}
        background="auto"
        cdn="bunny"
        className={className}
        decoding="async"
        fetchpriority={priority ? "high" : undefined}
        height={imageHeight}
        layout={unpicLayout}
        loading={priority ? "eager" : "lazy"}
        src={buildBunnyLwImageSrc(deliveryToken)}
        width={imageWidth}
      />
    );
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
