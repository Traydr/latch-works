import { createFileRoute } from "@tanstack/react-router";
import { ManagementPage } from "@/features/management/ManagementPage";

export const Route = createFileRoute("/_authed/manage")({
  component: ManagementPage,
});
