import { createServerFn } from "@tanstack/react-start";
import { assertWebSessionAuthorized } from "../auth/assert-web-session";

export const getArchiveStats = createServerFn({ method: "GET" }).handler(async () => {
  await assertWebSessionAuthorized();

  const { readArchiveStats } = await import("../../server/stats/archive-stats");

  return readArchiveStats();
});
