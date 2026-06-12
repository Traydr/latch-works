import { createServerFn } from "@tanstack/react-start";

export const isCurrentWebSessionValid = createServerFn({ method: "GET" }).handler(async () => {
  const [{ isRequestSessionValid }, { getRequest }] = await Promise.all([
    import("./web-session-core"),
    import("@tanstack/react-start/server"),
  ]);

  return isRequestSessionValid({
    request: getRequest(),
  });
});
