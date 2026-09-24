/**
 * The JSON request headers for a call forwarded to Better Auth: the caller's
 * session cookie, origin, and user agent, so the auth handler sees the
 * browser's request rather than the route's.
 */
export function forwardedAuthHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });

  for (const name of ["Cookie", "Origin", "User-Agent"]) {
    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  return headers;
}

/** A 303 to `location` that carries every cookie the Better Auth response set. */
export function redirectWithAuthCookies(authResponse: Response, location: string): Response {
  const headers = new Headers({ Location: location });

  for (const cookie of authResponse.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { headers, status: 303 });
}
