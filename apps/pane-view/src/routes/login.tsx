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
    <main className="login-shell">
      <form action="/api/auth/login" className="login-form" method="post">
        <div className="brand-row login-brand">
          <div className="brand-mark" aria-hidden="true">
            LW
          </div>
          <div>
            <strong>Pane View</strong>
            <span>Private archive access</span>
          </div>
        </div>

        <label>
          <span>Username</span>
          <input autoComplete="username" name="username" required type="text" />
        </label>

        <label>
          <span>Password</span>
          <input autoComplete="current-password" name="password" required type="password" />
        </label>

        {search.error === "invalid" ? (
          <p className="form-error">Those credentials did not match Pane View.</p>
        ) : null}

        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
