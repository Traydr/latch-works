import { createServerFn } from "@tanstack/react-start";

export interface SessionStatus {
  authenticated: boolean;
}

export const getSessionStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionStatus> => {
    const [{ isRequestSessionValid }, { getRequest }] = await Promise.all([
      import("../../server/auth/web-session-core"),
      import("@tanstack/react-start/server"),
    ]);

    return { authenticated: await isRequestSessionValid({ request: getRequest() }) };
  },
);
