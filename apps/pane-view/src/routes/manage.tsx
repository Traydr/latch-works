import { createFileRoute } from "@tanstack/react-router";
import { ManagementPage } from "@/features/management/ManagementPage";
import { requireWebSession } from "@/server/auth/require-web-session";

export const Route = createFileRoute("/manage")({
  beforeLoad: async () => {
    await requireWebSession();
  },
  component: ManagementPage,
});
