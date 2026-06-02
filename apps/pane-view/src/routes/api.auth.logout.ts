import { createFileRoute } from "@tanstack/react-router";
import { buildExpiredSessionCookie, readCookie, sessionCookieName } from "../server/auth/session";
import { revokeStoredSession } from "../server/auth/session-store";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        await revokeStoredSession({
          env: process.env,
          token: readCookie(request.headers.get("Cookie"), sessionCookieName),
        });

        return new Response(null, {
          headers: {
            "Set-Cookie": buildExpiredSessionCookie(),
            Location: "/login",
          },
          status: 303,
        });
      },
    },
  },
});
