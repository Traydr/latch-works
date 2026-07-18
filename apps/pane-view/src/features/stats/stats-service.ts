import { createServerFn } from "@tanstack/react-start";
import { readArchiveStats } from "../../server/stats/archive-stats";
import { assertWebSessionAuthorized } from "../library/library-service";

export const getArchiveStats = createServerFn({ method: "GET" }).handler(async () => {
  await assertWebSessionAuthorized();
  return readArchiveStats();
});
