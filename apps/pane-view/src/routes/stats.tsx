import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionStatus } from "@/features/auth/session-service";
import { StatsPage } from "@/features/stats/StatsPage";

export const Route = createFileRoute("/stats")({
  ssr: false,
  loader: async () => {
    const { authenticated } = await getSessionStatus();
    if (!authenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: StatsPage,
});
