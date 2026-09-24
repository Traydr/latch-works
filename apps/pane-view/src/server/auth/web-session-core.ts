import { auth, readConfiguredOwner, reconcileConfiguredOwner } from "./better-auth";

export async function isRequestSessionValid({ request }: { request: Request }): Promise<boolean> {
  await reconcileConfiguredOwner();

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  return isConfiguredOwnerSession(session);
}

export async function readRequestSessionUserId({
  request,
}: {
  request: Request;
}): Promise<string | null> {
  await reconcileConfiguredOwner();

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!isConfiguredOwnerSession(session)) {
    return null;
  }

  return session?.user.id ?? null;
}

function isConfiguredOwnerSession(
  session: Awaited<ReturnType<typeof auth.api.getSession>>,
): boolean {
  const owner = readConfiguredOwner();

  return Boolean(owner && session && session.user.email.toLowerCase() === owner.email);
}
