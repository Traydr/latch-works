import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { siteByKey } from "./link-sites";

/** A site's letters on its colour; letters, never the site's logo. */
export function SiteBadge({ className, site }: { className?: string; site: string }) {
  const { badge, badgeColor, badgeInk, label } = siteByKey(site);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center rounded-[5px] text-[8.5px] leading-none font-bold tracking-tight text-white",
        className,
      )}
      style={{ backgroundColor: badgeColor, color: badgeInk }}
      title={label}
    >
      {badge}
    </span>
  );
}

/** A canonical link with its host muted, so the part that tells links apart stands out. */
export function LinkText({
  canonicalUrl,
  className,
}: {
  canonicalUrl: string;
  className?: string;
}) {
  const slash = canonicalUrl.search(/[/?]/);
  const host = slash === -1 ? canonicalUrl : canonicalUrl.slice(0, slash);
  const rest = slash === -1 ? "" : canonicalUrl.slice(slash);

  return (
    <span className={cn("min-w-0 truncate", className)} title={canonicalUrl}>
      <span className="text-muted-foreground">{host}</span>
      {rest}
    </span>
  );
}

export function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning";
}) {
  return (
    <span
      className={cn(
        "ml-2 shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium",
        tone === "warning" ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
