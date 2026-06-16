import { createFileRoute } from "@tanstack/react-router";
import { requireCurrentWebSession } from "@/features/auth/web-session-guard";
import { GalleryLayout } from "@/features/gallery/GalleryLayout";

export const Route = createFileRoute("/_gallery")({
  beforeLoad: async () => {
    await requireCurrentWebSession();
  },
  component: GalleryLayout,
});
