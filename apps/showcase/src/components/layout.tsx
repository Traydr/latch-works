import { NavLink } from "react-router-dom";
import { apps, tools } from "@/data/products";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    "rounded-md px-3 py-2 text-sm transition",
    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
  ].join(" ");

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/70 bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <NavLink to="/" className="group flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-8 rounded-md" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold tracking-tight text-foreground group-hover:text-primary">
              Latch Works
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">Private media tools</p>
          </div>
        </NavLink>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          <NavLink to="/" end className={navLinkClass}>
            Overview
          </NavLink>
          {apps.map((product) => (
            <NavLink key={product.slug} to={`/${product.slug}`} className={navLinkClass}>
              {product.name}
            </NavLink>
          ))}
          {tools.map((product) => (
            <NavLink key={product.slug} to={`/${product.slug}`} className={navLinkClass}>
              {product.name}
            </NavLink>
          ))}
        </nav>

        <details className="relative md:hidden">
          <summary className="cursor-pointer list-none rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
            Menu
          </summary>
          <div className="absolute right-0 z-50 mt-2 w-48 rounded-lg border border-border bg-card p-2 shadow-lg">
            <NavLink to="/" end className={navLinkClass}>
              Overview
            </NavLink>
            {[...apps, ...tools].map((product) => (
              <NavLink key={product.slug} to={`/${product.slug}`} className={navLinkClass}>
                {product.name}
              </NavLink>
            ))}
          </div>
        </details>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70 bg-card/40">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <p className="font-medium text-foreground">Latch Works</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            A private workshop for collecting, syncing, and viewing a personal media archive.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">Gather → Organize → Sync → View</p>
      </div>
    </footer>
  );
}

export function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
