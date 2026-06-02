import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { isRequestSessionValid } from "./web-session-core";

export const isCurrentWebSessionValid = createServerFn({ method: "GET" }).handler(async () =>
  isRequestSessionValid({
    env: process.env,
    request: getRequest(),
  }),
);
