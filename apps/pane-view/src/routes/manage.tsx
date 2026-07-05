import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSessionStatus } from "@/features/auth/session-service";
import { ManagementPage } from "@/features/management/ManagementPage";

export const Route = createFileRoute("/manage")({
  ssr: false,
  loader: async () => {
    const { authenticated } = await getSessionStatus();
    if (!authenticated) {
      throw redirect({ to: "/login" });
    }
  },
  component: ManagementPage,
});
