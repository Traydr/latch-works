import { PaneViewImage } from "./PaneViewImage";

export function ResolvedMediaImage({
  alt,
  className,
  mediaId,
  mediaType,
  priority = false,
  revision,
  size = 320,
  variant = "preview",
  width,
}: {
  alt: string;
  className?: string;
  mediaId: string;
  mediaType: "image" | "gif" | "video" | "pdf" | "unknown";
  priority?: boolean;
  revision?: string;
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
      mediaId={mediaId}
      objectFit="contain"
      priority={priority}
      revision={revision}
      variant={resolvedVariant}
      width={width ?? size}
    />
  );
}
