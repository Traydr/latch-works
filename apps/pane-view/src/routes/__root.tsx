/// <reference types="vite/client" />
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { Home, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
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
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: AppNotFound,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function AppNotFound() {
  return (
    <main className="not-found-shell">
      <section className="not-found-panel" aria-labelledby="not-found-title">
        <div className="not-found-icon" aria-hidden="true">
          <SearchX size={28} />
        </div>
        <p>404</p>
        <h1 id="not-found-title">Archive path not found</h1>
        <span>The page or media route you opened does not exist in Pane View.</span>
        <Link className="primary-link" to="/">
          <Home size={16} />
          <span>Back to archive</span>
        </Link>
      </section>
    </main>
  );
}
