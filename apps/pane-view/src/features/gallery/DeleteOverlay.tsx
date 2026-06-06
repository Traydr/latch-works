import { cn } from "@/lib/utils";

interface DeleteOverlayProps {
  animated?: boolean;
  className?: string;
}

export function DeleteOverlay({ animated = false, className }: DeleteOverlayProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-10 rounded-[inherit]",
        animated && "animate-pulse",
        className,
      )}
      style={{
        backgroundColor: "rgba(220, 38, 38, 0.12)",
        backgroundImage: `repeating-linear-gradient(
          -45deg,
          transparent,
          transparent 7px,
          rgba(220, 38, 38, 0.55) 7px,
          rgba(220, 38, 38, 0.55) 9px
        )`,
      }}
    />
  );
}
