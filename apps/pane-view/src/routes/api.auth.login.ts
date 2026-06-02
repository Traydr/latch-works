import { createFileRoute } from "@tanstack/react-router";
import {
  buildSessionCookie,
  createSessionToken,
  verifySingleUserCredentials,
} from "../server/auth/session";
import { createStoredSession } from "../server/auth/session-store";

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
        const session = await createStoredSession({
          env: process.env,
          token,
          username,
        });

        return new Response(null, {
          headers: {
            "Set-Cookie": buildSessionCookie(session.token, session.expiresAt),
            Location: "/",
          },
          status: 303,
        });
      },
    },
  },
});
