import { createFileRoute } from "@tanstack/react-router";
import {
  auth,
  ensureConfiguredOwnerCredentialAccount,
  verifyConfiguredOwnerCredentials,
} from "../server/auth/better-auth";

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const formData = await request.formData();
        const username = String(formData.get("username") ?? "");
        const password = String(formData.get("password") ?? "");
        const owner = verifyConfiguredOwnerCredentials({
          env: process.env,
          password,
          username,
        });

        if (!owner) {
          return new Response(null, {
            headers: { Location: "/login?error=invalid" },
            status: 303,
          });
        }

        const signInResponse = await callBetterAuthEndpoint(request, "/api/auth/sign-in/email", {
          email: owner.email,
          password: owner.password,
          rememberMe: true,
        });

        if (signInResponse.ok) {
          return redirectWithAuthCookies(signInResponse, "/");
        }

        const signUpResponse = await callBetterAuthEndpoint(request, "/api/auth/sign-up/email", {
          email: owner.email,
          name: owner.name,
          password: owner.password,
          rememberMe: true,
        });

        if (signUpResponse.ok) {
          return redirectWithAuthCookies(signUpResponse, "/");
        }

        if (await ensureConfiguredOwnerCredentialAccount(owner, process.env)) {
          const migratedSignInResponse = await callBetterAuthEndpoint(
            request,
            "/api/auth/sign-in/email",
            {
              email: owner.email,
              password: owner.password,
              rememberMe: true,
            },
          );

          if (migratedSignInResponse.ok) {
            return redirectWithAuthCookies(migratedSignInResponse, "/");
          }
        }

        return new Response(null, {
          headers: { Location: "/login?error=invalid" },
          status: 303,
        });
      },
    },
  },
});

async function callBetterAuthEndpoint(
  incomingRequest: Request,
  pathname: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(pathname, incomingRequest.url);
  const headers = new Headers();
  copyHeader(incomingRequest.headers, headers, "Cookie");
  copyHeader(incomingRequest.headers, headers, "Origin");
  copyHeader(incomingRequest.headers, headers, "User-Agent");
  headers.set("Content-Type", "application/json");

  return auth.handler(
    new Request(url, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }),
  );
}

function redirectWithAuthCookies(authResponse: Response, location: string): Response {
  const headers = new Headers({ Location: location });
  copySetCookies(authResponse.headers, headers);

  return new Response(null, {
    headers,
    status: 303,
  });
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (value) {
    target.set(name, value);
  }
}

function copySetCookies(source: Headers, target: Headers): void {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = getSetCookie ? getSetCookie.call(source) : [];

  if (setCookies.length) {
    for (const cookie of setCookies) {
      target.append("Set-Cookie", cookie);
    }
    return;
  }

  const cookie = source.get("Set-Cookie");
  if (cookie) {
    target.append("Set-Cookie", cookie);
  }
}
