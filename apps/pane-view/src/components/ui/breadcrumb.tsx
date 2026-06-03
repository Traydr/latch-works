import { ChevronRight, MoreHorizontal } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Breadcrumb({ className, ...props }: ComponentPropsWithoutRef<"nav">) {
  return <nav aria-label="breadcrumb" className={cn("min-w-0", className)} {...props} />;
}

export function BreadcrumbList({ className, ...props }: ComponentPropsWithoutRef<"ol">) {
  return (
    <ol
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 break-words text-sm text-zinc-500 dark:text-zinc-400",
        className,
      )}
      {...props}
    />
  );
}

export function BreadcrumbItem({ className, ...props }: ComponentPropsWithoutRef<"li">) {
  return <li className={cn("inline-flex min-w-0 items-center gap-1.5", className)} {...props} />;
}

export function BreadcrumbLink({ className, ...props }: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      className={cn(
        "min-w-0 truncate text-left transition-colors hover:text-zinc-900 dark:hover:text-zinc-50",
        className,
      )}
      type="button"
      {...props}
    />
  );
}

export function BreadcrumbPage({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      aria-current="page"
      className={cn("min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-50", className)}
      {...props}
    />
  );
}

export function BreadcrumbSeparator({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("text-zinc-400 dark:text-zinc-600", className)}>
      {children ?? <ChevronRight size={14} />}
    </span>
  );
}

export function BreadcrumbEllipsis({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex h-5 w-5 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal size={14} />
    </span>
  );
}
