import { Link } from "@tanstack/react-router";
import { Home, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppNotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-5 text-foreground">
      <section
        className="grid w-full max-w-md justify-items-center gap-3 rounded-xl bg-popover p-6 text-center text-popover-foreground shadow-float"
        aria-labelledby="not-found-title"
      >
        <div
          className="grid size-12 place-items-center rounded-lg bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <SearchX size={28} />
        </div>
        <p className="m-0 text-sm font-semibold text-muted-foreground">404</p>
        <h1 className="m-0 text-balance text-xl font-semibold" id="not-found-title">
          Archive path not found
        </h1>
        <span className="text-pretty text-sm text-muted-foreground">
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
