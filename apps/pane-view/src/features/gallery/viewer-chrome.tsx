import type { LucideIcon } from "lucide-react";
import type { CSSProperties, JSX, ReactNode, Ref } from "react";

const ICON_BUTTON_SIZE = {
  sm: "size-8 [&>svg]:size-4",
  md: "size-10 [&>svg]:size-5",
} as const;

const ICON_BUTTON_TONE = {
  /** The video capsule's controls. */
  capsule:
    "hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-violet-400 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent",
  /** The top bar's actions. */
  bar: "hover:bg-violet-500/25 hover:text-violet-100",
} as const;

export interface IconButtonProps {
  active?: boolean;
  /** Drawn over the icon. */
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  fill?: boolean;
  icon: LucideIcon;
  /** The accessible name, and the tooltip unless `title` says otherwise. */
  label: string;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
  size?: keyof typeof ICON_BUTTON_SIZE;
  title?: string;
  tone?: keyof typeof ICON_BUTTON_TONE;
}

/** The round icon button of the viewer, the video capsule, and the comic reader. */
export function IconButton({
  active = false,
  children,
  className = "",
  disabled = false,
  fill = false,
  icon: Icon,
  label,
  onClick,
  ref,
  size = "md",
  title = label,
  tone = "capsule",
}: IconButtonProps): JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full transition ${ICON_BUTTON_TONE[tone]} ${ICON_BUTTON_SIZE[size]} ${active ? "text-violet-300" : "text-white/90"} ${className}`}
      onClick={onClick}
    >
      <Icon className={fill ? "fill-current" : undefined} />
      {children}
    </button>
  );
}

const TOP_BAR_STYLE: CSSProperties = { paddingTop: "max(0.75rem, env(safe-area-inset-top))" };

/** The gradient across the top of a full-screen viewer; it fades with the chrome. */
export function ViewerTopBar({
  children,
  visibilityClass,
}: {
  children: ReactNode;
  visibilityClass: string;
}): JSX.Element {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/70 via-black/30 to-transparent px-3 pb-8 pt-3 transition-opacity duration-300 ${visibilityClass}`}
      style={TOP_BAR_STYLE}
    >
      {children}
    </div>
  );
}
