import { Image } from "@unpic/react/base";
import { paneViewImageTransformer } from "./pane-view-image-transformer";
import { buildMediaApiUrl } from "./pane-view-media-url";

const previewBreakpoint = 960;

type PaneViewImageProps = {
  alt: string;
  breakpoints?: number[];
  className?: string;
  height?: number;
  layout?: "fixed" | "constrained" | "fullWidth";
  mediaId: string;
  objectFit?: "contain" | "cover" | "fill" | "none" | "scale-down";
  priority?: boolean;
  unstyled?: boolean;
  variant?: "thumbnail" | "preview" | "original";
  width?: number;
};

export function PaneViewImage({
  alt,
  breakpoints,
  className,
  height,
  layout = "constrained",
  mediaId,
  objectFit,
  priority = false,
  unstyled = true,
  variant = "thumbnail",
  width = 320,
}: PaneViewImageProps) {
  const src = buildMediaApiUrl(
    mediaId,
    variant,
    variant === "thumbnail" ? width : undefined,
  );

  if (variant === "original") {
    return (
      <img
        alt={alt}
        className={className}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        loading={priority ? "eager" : "lazy"}
        src={src}
      />
    );
  }

  const resolvedBreakpoints = variant === "preview" ? [previewBreakpoint] : breakpoints;
  const sharedProps = {
    alt,
    breakpoints: resolvedBreakpoints,
    className,
    objectFit,
    priority,
    src,
    transformer: paneViewImageTransformer,
    unstyled,
  };

  if (layout === "fullWidth") {
    return <Image {...sharedProps} height={height} layout="fullWidth" />;
  }

  if (layout === "fixed") {
    return (
      <Image {...sharedProps} height={height ?? width} layout="fixed" width={width} />
    );
  }

  return (
    <Image {...sharedProps} height={height ?? width} layout="constrained" width={width} />
  );
}
