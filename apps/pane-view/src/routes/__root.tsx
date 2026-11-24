import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { ServiceWorkerUpdates } from "@/features/offline/ServiceWorkerUpdates";
import { ThemeColorSync } from "@/features/settings/ThemeSync";
import appCss from "../styles.css?url";
import { AppNotFound } from "./-app-not-found";
import { RootDocument } from "./-root-document";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: "Pane View" },
      {
        name: "description",
        content: "Private web viewer for a path-preserving media archive.",
      },
      // The Home Screen name, under the icon. iOS truncates it near 12 characters.
      { name: "apple-mobile-web-app-title", content: "Pane" },
      // A solid status bar (plan 066, D2): the page starts below it, so no top inset is needed.
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico" },
      { rel: "icon", href: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
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
        <ThemeColorSync />
        <Outlet />
        <ServiceWorkerUpdates />
      </ThemeProvider>
    </RootDocument>
  );
}
