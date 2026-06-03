import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../server/auth/better-auth";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const signOutResponse = await auth.handler(
          new Request(new URL("/api/auth/sign-out", request.url), {
            body: "{}",
            headers: buildAuthHeaders(request),
            method: "POST",
          }),
        );
        const headers = new Headers({ Location: "/login" });
        copySetCookies(signOutResponse.headers, headers);

        return new Response(null, {
          headers,
          status: 303,
        });
      },
    },
  },
});

function buildAuthHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  copyHeader(request.headers, headers, "Cookie");
  copyHeader(request.headers, headers, "Origin");
  copyHeader(request.headers, headers, "User-Agent");
  return headers;
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
