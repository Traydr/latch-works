import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { type DeliveryCacheRequest, deliveryCacheKey } from "./delivery-cache";
import type { DeliveryVariant } from "./delivery-contract";
import { useDeliveryUrl } from "./useDeliveryUrl";
import { useImageLoadRetry } from "./useImageLoadRetry";

type PaneViewImageProps = {
  alt: string;
  className?: string;
  mediaId: string;
  objectFit?: "contain" | "cover" | "fill" | "none" | "scale-down";
  priority?: boolean;
  /** A URL the caller already resolved (a grid tile's batch answer). */
  readyUrl?: string;
  /** The item's content hash; a replaced file resolves a fresh URL. */
  revision: string;
  variant: DeliveryVariant;
  /** The rendition's width in device pixels; an original ignores it. */
  width: number;
};

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
  className,
  mediaId,
  objectFit,
  priority = false,
  readyUrl,
  revision,
  variant,
  width,
}: PaneViewImageProps) {
  const request: DeliveryCacheRequest =
    variant === "original" ? { mediaId, revision, variant } : { mediaId, revision, variant, width };

  const retry = useImageLoadRetry(`${deliveryCacheKey(request)}:${readyUrl ?? ""}`);

  const { failed, loading, resolvedUrl } = useDeliveryUrl({
    readyUrl: retry.shouldRefreshUrl ? undefined : readyUrl,
    refresh: retry.shouldRefreshUrl,
    request,
  });

  // Checked first: a failed resolve has no URL and would otherwise sit as a loading box.
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

  if (loading || !resolvedUrl || retry.phase === "waiting") {
    return <div aria-hidden className={cn(className, "bg-zinc-800/80")} />;
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
