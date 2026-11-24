import { HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_COLOR_METAS } from "@/features/settings/theme-color";

export function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Here, not in the root route's head(): it keeps one meta per name, and these share one. */}
        {THEME_COLOR_METAS.map((meta) => (
          <meta content={meta.content} key={meta.media} media={meta.media} name={meta.name} />
        ))}
      </head>
      <body suppressHydrationWarning>
        <TooltipProvider>{children}</TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}
