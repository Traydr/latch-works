import { createFileRoute, redirect } from "@tanstack/react-router";
import { isCurrentWebSessionValid } from "../server/auth/web-session";

export const Route = createFileRoute("/login")({
  validateSearch: (search): { error?: string } => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  loader: async () => {
    if (await isCurrentWebSessionValid()) {
      throw redirect({ to: "/" });
    }
  },
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();

  return (
    <main className="grid min-h-screen place-items-center bg-zinc-950 p-5 text-zinc-100">
      <form
        action="/api/auth/login"
        className="grid w-full max-w-sm gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-5"
        method="post"
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
          <div
            className="grid size-9 place-items-center rounded-md border border-zinc-700 text-xs font-bold text-amber-300"
            aria-hidden="true"
          >
            LW
          </div>
          <div>
            <strong className="block text-sm font-semibold">Pane View</strong>
            <span className="block text-xs text-zinc-400">Private archive access</span>
          </div>
        </div>

        <label className="grid gap-1.5">
          <span className="text-xs text-zinc-400">Username</span>
          <input
            autoComplete="username"
            className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none focus:border-amber-300"
            name="username"
            required
            type="text"
          />
        </label>

        <label className="grid gap-1.5">
          <span className="text-xs text-zinc-400">Password</span>
          <input
            autoComplete="current-password"
            className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm outline-none focus:border-amber-300"
            name="password"
            required
            type="password"
          />
        </label>

        {search.error === "invalid" ? (
          <p className="m-0 text-sm text-red-300">Those credentials did not match Pane View.</p>
        ) : null}

        <button
          className="h-9 rounded-md border border-amber-500/70 bg-amber-300 text-sm font-semibold text-zinc-950"
          type="submit"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
