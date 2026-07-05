import { createServerFn } from "@tanstack/react-start";

export interface SessionStatus {
  authenticated: boolean;
}

export async function readSessionStatus(): Promise<SessionStatus> {
  const [{ isRequestSessionValid }, { getRequest }] = await Promise.all([
    import("../../server/auth/web-session-core"),
    import("@tanstack/react-start/server"),
  ]);

  const authenticated = await isRequestSessionValid({
    request: getRequest(),
  });

  return { authenticated };
}

export const getSessionStatus = createServerFn({ method: "GET" }).handler(readSessionStatus);
