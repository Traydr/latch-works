import { PaneViewImage } from "./PaneViewImage";

export function ResolvedMediaImage({
  alt,
  className,
  layout = "constrained",
  mediaId,
  mediaType,
  priority = false,
  size = 320,
  variant = "preview",
  width,
}: {
  alt: string;
  className?: string;
  layout?: "fixed" | "constrained" | "fullWidth";
  mediaId: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  priority?: boolean;
  size?: number;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
}) {
  const resolvedVariant =
    variant === "original" ? "original" : mediaType === "image" ? "preview" : "original";

  return (
    <PaneViewImage
      alt={alt}
      className={className}
      layout={layout}
      mediaId={mediaId}
      objectFit="contain"
      priority={priority}
      variant={resolvedVariant}
      width={width ?? size}
    />
  );
}
