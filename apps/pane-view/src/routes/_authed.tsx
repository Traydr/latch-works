import { createFileRoute, redirect } from "@tanstack/react-router";
import { signInHref } from "@/features/auth/return-path";
import { getSessionStatus } from "@/features/auth/session-service";

/**
 * Every owner-only page nests here. The session check is a `beforeLoad`, which
 * the router finishes before any child route's loader starts. It runs when the
 * owner enters these pages, not on every navigation among them ("stay"): it
 * would block each search and filter change on a round trip, and a session
 * that lapses meanwhile is refused by every server function anyway. The login
 * page remembers where the owner was, and returns there after signing in.
 */
export const Route = createFileRoute("/_authed")({
  ssr: false,
  beforeLoad: async ({ cause, location }) => {
    if (cause === "stay") return;

    const { authenticated } = await getSessionStatus();

    if (!authenticated) {
      throw redirect({ href: signInHref(location.href) });
    }
  },
});
