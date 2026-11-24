import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { redirectToSignIn } from "@/features/auth/return-path";
import { UnauthorizedErrorSchema } from "@/features/auth/unauthorized";

/**
 * A request refused because the session lapsed sends the owner to sign in, then back here,
 * instead of leaving an error on screen. An installed Home Screen app has no address bar to
 * recover from that error with.
 */
function signInWhenUnauthorized(error: Error): void {
  if (isUnauthorized(error)) redirectToSignIn();
}

function isUnauthorized(error: Error): boolean {
  return UnauthorizedErrorSchema.safeParse(error).success;
}

/** React Query's default, three retries, except for a lapsed session: retrying cannot fix it. */
const MAX_RETRIES = 3;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => !isUnauthorized(error) && failureCount < MAX_RETRIES,
        staleTime: 30_000,
      },
    },
    mutationCache: new MutationCache({ onError: signInWhenUnauthorized }),
    queryCache: new QueryCache({ onError: signInWhenUnauthorized }),
  });
}
