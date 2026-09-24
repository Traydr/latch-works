import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env/server";
import {
  auth,
  reconcileConfiguredOwner,
  verifyConfiguredOwnerCredentials,
} from "../server/auth/better-auth";
import { resolveClientIp } from "../server/auth/client-ip";
import { clearLoginThrottle, reserveLoginAttempt } from "../server/auth/login-throttle";
import { forwardedAuthHeaders, redirectWithAuthCookies } from "../server/http/auth-forwarding";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const formData = await request.formData();
        const username = String(formData.get("username") ?? "");
        const password = String(formData.get("password") ?? "");
        const clientIp = resolveClientIp(request, env.PANE_VIEW_TRUST_PROXY_HEADERS);

        // Counted before verifying, so parallel guesses cannot all pass the check at once.
        if (!(await reserveLoginAttempt(clientIp, username))) {
          return new Response(null, {
            headers: { Location: "/login?error=invalid" },
            status: 303,
          });
        }

        const owner = verifyConfiguredOwnerCredentials({
          password,
          username,
        });

        if (!owner) {
          return new Response(null, {
            headers: { Location: "/login?error=invalid" },
            status: 303,
          });
        }

        await reconcileConfiguredOwner();

        const signInResponse = await callBetterAuthEndpoint(request, "/api/auth/sign-in/email", {
          email: owner.email,
          password: owner.password,
          rememberMe: true,
        });

        if (signInResponse.ok) {
          await clearLoginThrottle(clientIp, username);

          return redirectWithAuthCookies(signInResponse, "/");
        }

        return new Response(null, {
          headers: { Location: "/login?error=invalid" },
          status: 303,
        });
      },
    },
  },
});

interface EmailSignInBody {
  email: string;
  password: string;
  rememberMe: boolean;
}

async function callBetterAuthEndpoint(
  incomingRequest: Request,
  pathname: string,
  body: EmailSignInBody,
): Promise<Response> {
  return auth.handler(
    new Request(new URL(pathname, incomingRequest.url), {
      body: JSON.stringify(body),
      headers: forwardedAuthHeaders(incomingRequest),
      method: "POST",
    }),
  );
}
