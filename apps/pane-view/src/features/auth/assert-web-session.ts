/**
 * The session guard every owner-only server function runs first. Server
 * modules load lazily so a feature's client bundle never pulls them in.
 */
export async function assertWebSessionAuthorized(): Promise<void> {
  const [{ isRequestSessionValid }, { getRequest }] = await Promise.all([
    import("../../server/auth/web-session-core"),
    import("@tanstack/react-start/server"),
  ]);

  if (!(await isRequestSessionValid({ request: getRequest() }))) {
    throw new Error("Unauthorized");
  }
}
