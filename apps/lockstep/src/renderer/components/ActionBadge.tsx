interface ActionBadgeProps {
  action: string;
}

export function ActionBadge({ action }: ActionBadgeProps) {
  const className = (() => {
    switch (action) {
      case "upload":
        return "border-sky-300/80 bg-sky-100/80 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200";
      case "update":
        return "border-amber-300/80 bg-amber-100/80 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100";
      case "delete":
        return "border-red-300/80 bg-red-100/80 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200";
      default:
        return "border-zinc-300/80 bg-zinc-100/80 text-zinc-700 dark:border-zinc-600/80 dark:bg-zinc-800/80 dark:text-zinc-200";
    }
  })();

  return (
    <span
      className={`inline-flex min-w-[4.5rem] items-center justify-center rounded-lg border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${className}`}
    >
      {action}
    </span>
  );
}
