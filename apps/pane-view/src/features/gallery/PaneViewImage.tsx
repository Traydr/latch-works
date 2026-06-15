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
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

export function PaneViewImage({
  alt,
  className,
  mediaId,
  objectFit,
  priority = false,
  variant = "thumbnail",
  width = 320,
}: PaneViewImageProps) {
  const { failed, loading, resolvedUrl } = useResolvedMediaUrl({
    mediaId,
    size: variant === "thumbnail" ? width : undefined,
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
