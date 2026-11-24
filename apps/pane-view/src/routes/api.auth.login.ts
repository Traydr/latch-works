import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env/server";
import { safeReturnPath, signInHref } from "../features/auth/return-path";
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
        // The page the owner was on when the session lapsed; a failed attempt keeps it.
        const returnTo = safeReturnPath(String(formData.get("redirect") ?? ""));

        const invalid = new Response(null, {
          headers: { Location: signInHref(returnTo, "invalid") },
          status: 303,
        });

        const clientIp = resolveClientIp(request, env.PANE_VIEW_TRUST_PROXY_HEADERS);

        // Counted before verifying, so parallel guesses cannot all pass the check at once.
        if (!(await reserveLoginAttempt(clientIp, username))) {
          return invalid;
        }

        const owner = verifyConfiguredOwnerCredentials({
          password,
          username,
        });

        if (!owner) {
          return invalid;
        }

        await reconcileConfiguredOwner();

        const signInResponse = await callBetterAuthEndpoint(request, "/api/auth/sign-in/email", {
          email: owner.email,
          password: owner.password,
          rememberMe: true,
        });

        if (signInResponse.ok) {
          await clearLoginThrottle(clientIp, username);

          return redirectWithAuthCookies(signInResponse, returnTo);
        }

        return invalid;
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
