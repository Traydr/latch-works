import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { Home, SearchX } from "lucide-react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Pane View" },
      {
        name: "description",
        content: "Private web viewer for a path-preserving media archive.",
      },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  notFoundComponent: AppNotFound,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <Outlet />
      </ThemeProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        <TooltipProvider>{children}</TooltipProvider>
        <Scripts />
      </body>
    </html>
  );
}

function AppNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-950 p-5 text-zinc-100">
      <section
        className="grid w-full max-w-md justify-items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center"
        aria-labelledby="not-found-title"
      >
        <div
          className="grid size-12 place-items-center rounded-lg border border-zinc-700 text-amber-300"
          aria-hidden="true"
        >
          <SearchX size={28} />
        </div>
        <p className="m-0 text-sm font-semibold text-zinc-400">404</p>
        <h1 className="m-0 text-xl font-semibold" id="not-found-title">
          Archive path not found
        </h1>
        <span className="text-sm text-zinc-400">
          The page or media route you opened does not exist in Pane View.
        </span>
        <Button asChild className="mt-1 gap-2" size="lg">
          <Link to="/">
            <Home size={16} />
            <span>Back to archive</span>
          </Link>
        </Button>
      </section>
    </main>
  );
}
