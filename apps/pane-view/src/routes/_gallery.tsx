import { createFileRoute } from "@tanstack/react-router";
import { GalleryLayout } from "@/features/gallery/GalleryLayout";
import { requireWebSession } from "@/server/auth/require-web-session";

export const Route = createFileRoute("/_gallery")({
  beforeLoad: async () => {
    await requireWebSession();
  },
  component: GalleryLayout,
});
