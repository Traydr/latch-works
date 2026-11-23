import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSessionStatus } from "@/features/auth/session-service";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ error: z.string().optional().catch(undefined) }),
  ssr: false,
  loader: async () => {
    const { authenticated } = await getSessionStatus();

    if (authenticated) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();

  return (
    <main className="grid min-h-screen place-items-center bg-background p-5 text-foreground">
      <form
        action="/api/auth/login"
        className="grid w-full max-w-sm gap-4 rounded-xl bg-popover p-5 text-popover-foreground shadow-float"
        method="post"
      >
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <img
            alt=""
            aria-hidden="true"
            className="size-9 shrink-0 rounded-md"
            height={36}
            src="/favicon.svg"
            width={36}
          />
          <div>
            <strong className="block text-sm font-semibold">Pane View</strong>
            <span className="block text-pretty text-xs text-muted-foreground">
              Private archive access
            </span>
          </div>
        </div>

        <label className="grid gap-1.5" htmlFor="username">
          <span className="text-[13px] text-muted-foreground">Username</span>
          <Input autoComplete="username" id="username" name="username" required type="text" />
        </label>

        <label className="grid gap-1.5" htmlFor="password">
          <span className="text-[13px] text-muted-foreground">Password</span>
          <Input
            autoComplete="current-password"
            id="password"
            name="password"
            required
            type="password"
          />
        </label>

        {search.error === "invalid" ? (
          <p className="m-0 text-pretty text-sm text-destructive">
            Those credentials did not match Pane View.
          </p>
        ) : null}

        <Button size="lg" type="submit">
          Sign in
        </Button>
      </form>
    </main>
  );
}
