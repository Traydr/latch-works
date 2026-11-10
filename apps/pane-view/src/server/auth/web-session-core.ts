import { auth, readConfiguredOwner, reconcileConfiguredOwner } from "./better-auth";

/** The signed-in owner's user id, or null when the request carries no owner session. */
export async function readRequestSessionUserId({
  request,
}: {
  request: Request;
}): Promise<string | null> {
  await reconcileConfiguredOwner();

  const session = await auth.api.getSession({ headers: request.headers });
  const owner = readConfiguredOwner();

  if (!session || session.user.email.toLowerCase() !== owner.email) {
    return null;
  }

  return session.user.id;
}
