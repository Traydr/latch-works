import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth/better-auth";
import { forwardedAuthHeaders, redirectWithAuthCookies } from "../server/http/auth-forwarding";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const signOutResponse = await auth.handler(
          new Request(new URL("/api/auth/sign-out", request.url), {
            body: "{}",
            headers: forwardedAuthHeaders(request),
            method: "POST",
          }),
        );

        return redirectWithAuthCookies(signOutResponse, "/login");
      },
    },
  },
});
