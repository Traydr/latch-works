import { createFileRoute } from "@tanstack/react-router";
import { buildExpiredSessionCookie } from "../server/auth/session";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async () =>
        new Response(null, {
          headers: {
            "Set-Cookie": buildExpiredSessionCookie(),
            Location: "/login",
          },
          status: 303,
        }),
    },
  },
});
