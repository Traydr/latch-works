interface ProgressBarProps {
  indeterminate?: boolean;
  label?: string;
  percent: number | null;
  size?: "sm" | "md" | "lg";
  variant?: "default" | "segmented";
}

export function ProgressBar({
  indeterminate = false,
  label,
  percent,
  size = "md",
  variant = "default",
}: ProgressBarProps) {
  const heightClass = size === "sm" ? "h-1" : size === "lg" ? "h-3" : "h-2";
  const showIndeterminate = indeterminate || percent === null;

  return (
    <div className="w-full">
      {label ? (
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
          {!showIndeterminate && percent !== null ? (
            <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {percent}%
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={`relative overflow-hidden rounded-full bg-zinc-200/80 dark:bg-zinc-800/80 ${heightClass}`}
        role="progressbar"
        aria-valuenow={showIndeterminate ? undefined : (percent ?? 0)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {showIndeterminate ? (
          <div
            className={`absolute inset-y-0 w-1/3 rounded-full bg-violet-500/80 dark:bg-violet-400/80 ${
              variant === "segmented" ? "animate-pulse" : "animate-[progress-indeterminate_1.2s_ease-in-out_infinite]"
            }`}
          />
        ) : (
          <div
            className="h-full rounded-full bg-violet-500 transition-[width] duration-300 ease-out dark:bg-violet-400"
            style={{ width: `${percent ?? 0}%` }}
          />
        )}
      </div>
    </div>
  );
}
