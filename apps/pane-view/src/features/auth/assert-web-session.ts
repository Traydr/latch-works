import { UNAUTHORIZED_MESSAGE } from "./unauthorized";

/**
 * The signed-in owner's user id for the current server function request, or
 * null. Server modules load lazily so a feature's client bundle never pulls
 * them in.
 */
export async function readWebSessionUserId(): Promise<string | null> {
  const [{ readRequestSessionUserId }, { getRequest }] = await Promise.all([
    import("../../server/auth/web-session-core"),
    import("@tanstack/react-start/server"),
  ]);

  return readRequestSessionUserId({ request: getRequest() });
}

/** The session guard every owner-only server function runs first. */
export async function assertWebSessionAuthorized(): Promise<string> {
  const userId = await readWebSessionUserId();

  if (userId === null) {
    throw new Error(UNAUTHORIZED_MESSAGE);
  }

  return userId;
}
