import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export function Sidebar({ className, ...props }: ComponentPropsWithoutRef<"aside">) {
  return (
    <aside
      className={cn(
        "flex min-h-screen w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 text-zinc-100",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("border-b border-zinc-800 px-4 py-4", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-2 py-3", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: ComponentPropsWithoutRef<"nav">) {
  return <nav className={cn("grid gap-1", className)} {...props} />;
}

export function SidebarMenuButton({
  className,
  isActive,
  ...props
}: ComponentPropsWithoutRef<"button"> & { isActive?: boolean }) {
  return (
    <button
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-50",
        isActive && "bg-zinc-900 text-zinc-50",
        className,
      )}
      type="button"
      {...props}
    />
  );
}
