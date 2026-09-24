import type { JSX, ReactNode } from "react";
import type { HoldToBoost } from "./video-player/video-player-controls";

/**
 * The area the current item fills. A tap or click on it never reaches the
 * dialog's own handler; `onTap` decides what it does.
 */
export function ViewerStage({
  children,
  holdHandlers,
  onTap,
}: {
  children: ReactNode;
  /** A video's press-and-hold speed boost. */
  holdHandlers?: HoldToBoost["handlers"];
  onTap: () => void;
}): JSX.Element {
  return (
    <div
      className="flex h-full select-none items-center justify-center p-3 pb-[env(safe-area-inset-bottom)] [-webkit-touch-callout:none]"
      {...holdHandlers}
      onClick={(event) => {
        event.stopPropagation();
        onTap();
      }}
    >
      {children}
    </div>
  );
}
