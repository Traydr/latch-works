import { createFileRoute } from "@tanstack/react-router";
import {
  buildSessionCookie,
  createSessionToken,
  hashSessionToken,
  sessionExpiresAt,
  verifySingleUserCredentials,
} from "../server/auth/session";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const formData = await request.formData();
        const username = String(formData.get("username") ?? "");
        const password = String(formData.get("password") ?? "");

        if (!verifySingleUserCredentials({ env: process.env, password, username })) {
          return new Response("Invalid credentials", { status: 401 });
        }

        const token = createSessionToken();
        const expiresAt = sessionExpiresAt();

        // TODO: Store hashSessionToken(token) in Postgres once the database adapter is wired.
        hashSessionToken(token);

        return new Response(null, {
          headers: {
            "Set-Cookie": buildSessionCookie(token, expiresAt),
            Location: "/",
          },
          status: 303,
        });
      },
    },
  },
});
