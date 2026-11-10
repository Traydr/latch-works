import { createServerFn } from "@tanstack/react-start";
import { readWebSessionUserId } from "./assert-web-session";

export const getSessionStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ authenticated: boolean }> => ({
    authenticated: (await readWebSessionUserId()) !== null,
  }),
);
