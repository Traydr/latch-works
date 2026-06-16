import { createFileRoute } from "@tanstack/react-router";
import { requireCurrentWebSession } from "@/features/auth/web-session-guard";
import { ManagementPage } from "@/features/management/ManagementPage";

export const Route = createFileRoute("/manage")({
  beforeLoad: async () => {
    await requireCurrentWebSession();
  },
  component: ManagementPage,
});
