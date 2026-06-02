import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
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

        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
