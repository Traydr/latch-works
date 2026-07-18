import { useQuery } from "@tanstack/react-query";
import { getArchiveStats } from "./stats-service";

export const statsKeys = {
  all: ["stats"] as const,
  archive: () => [...statsKeys.all, "archive"] as const,
};

export function useArchiveStatsQuery() {
  return useQuery({
    queryKey: statsKeys.archive(),
    queryFn: () => getArchiveStats(),
    staleTime: 60_000,
  });
}
