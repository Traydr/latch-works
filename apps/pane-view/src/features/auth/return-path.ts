/**
 * Where to send the owner after signing in: the page they were on when the session lapsed. The
 * path round-trips through the login URL and form, so anyone can write it; only a path on this
 * site that renders a page is followed, and anything else returns to the gallery.
 */
const HOME = "/";

/** A base only for parsing: a path that resolves anywhere else is not on this site. */
const PARSE_BASE = "https://pane-view.invalid";

/** Paths that are not pages to come back to: the endpoints and the login page itself. */
const EXCLUDED_PREFIXES = ["/api/", "/_serverFn/", "/login"];

export function safeReturnPath(candidate: string | null | undefined): string {
  if (!candidate?.startsWith("/")) return HOME;

  let url: URL;

  try {
    url = new URL(candidate, PARSE_BASE);
  } catch {
    return HOME;
  }

  // `//host` and `/\host` resolve to another origin; so does anything a browser reads that way.
  if (url.origin !== PARSE_BASE) return HOME;

  if (EXCLUDED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return HOME;

  return `${url.pathname}${url.search}${url.hash}`;
}

/** The login page, remembering `returnTo` unless it is the gallery's root anyway. */
export function signInHref(returnTo: string, error?: "invalid"): string {
  const search = new URLSearchParams();

  if (error !== undefined) search.set("error", error);

  const path = safeReturnPath(returnTo);

  if (path !== HOME) search.set("redirect", path);

  const query = search.toString();

  return query === "" ? "/login" : `/login?${query}`;
}

/** Leaves a page whose session has lapsed for the login page, which brings the owner back. */
export function redirectToSignIn(): void {
  const { hash, pathname, search } = window.location;
  window.location.assign(signInHref(`${pathname}${search}${hash}`));
}
