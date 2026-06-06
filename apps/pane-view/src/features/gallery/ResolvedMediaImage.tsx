import { useResolvedMediaUrl } from "./useResolvedMediaUrl";

export function ResolvedMediaImage({
  alt,
  className,
  mediaId,
  mediaType,
  size = 320,
  variant = "preview",
}: {
  alt: string;
  className?: string;
  mediaId: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  size?: number;
  variant?: "thumbnail" | "preview" | "original";
}) {
  const primary = useResolvedMediaUrl({
    mediaId,
    size: variant === "thumbnail" ? size : undefined,
    variant: variant === "original" ? "original" : mediaType === "image" ? "preview" : "original",
  });
  const fallback = useResolvedMediaUrl({
    mediaId: primary.failed ? mediaId : undefined,
    variant: "original",
  });
  const src = primary.resolvedUrl ?? fallback.resolvedUrl;

  if (!src) {
    return null;
  }

  return <img alt={alt} className={className} decoding="async" loading="lazy" src={src} />;
}
